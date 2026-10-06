// What the `agent-lookout` command was asked to do, read from its arguments.
// It has three commands: `start`, the one run when none is named, which starts
// Agent Lookout itself; `status`, with three ways to print what it finds; and
// `mcp`, which serves the same to an agent over stdin and stdout. `--version`
// prints the version.

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

export interface StartOptions {
  /** The port given with `--port`, or null when none was. 0 lets the system choose. */
  port: number | null;
  /** Whether `--open` asked for the address to be opened in the browser. */
  open: boolean;
}

export type ParsedArguments =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "start"; options: StartOptions }
  | { kind: "status"; options: StatusOptions }
  | { kind: "mcp"; options: McpOptions }
  | { kind: "error"; message: string };

export const HELP = `Usage: agent-lookout [start] [--port <number>] [--open]
       agent-lookout status [--json | --count] [--url <address>]
       agent-lookout mcp [--url <address>]

start, the command run when none is named, starts Agent Lookout: the
dashboard and its API at http://127.0.0.1:4777, on this machine only,
until Ctrl+C. status prints which sessions need you, from the Agent
Lookout running on this machine. mcp gives the same to an AI agent: it
is a Model Context Protocol server on stdin and stdout, for the agent's
app to start. Its tools only read. Neither status nor mcp starts Agent
Lookout, and neither asks anything but Agent Lookout's own server.

Options:
  --port <number>  start: the port to listen on, 4777 unless this or
                   AGENT_LOOKOUT_PORT says otherwise
  --open           start: open the address in the default browser
  --json           status: print the counts and the waiting sessions as JSON
  --count          status: print only the number of sessions that need you
  --url <address>  Where Agent Lookout runs, such as http://127.0.0.1:4777.
                   AGENT_LOOKOUT_URL does the same. Without either, it tries
                   http://127.0.0.1:4777 (agent-lookout or npm start), then
                   http://localhost:5173 (npm run dev).
                   Only an address on this machine is accepted.
  -h, --help       Print this help
  -v, --version    Print the version of agent-lookout

Exit codes of status:
  0  Nothing needs you
  1  One or more sessions need you
  2  Agent Lookout could not be reached or read, has not read any agent
     yet, or the command was mistyped

start runs until Ctrl+C, then exits with 0. It exits with 1 when it
cannot start, such as when the port is in use, and with 2 when the
command was mistyped.

mcp runs until the app that started it closes its stdin, then exits with
0. It exits with 2 when the command was mistyped or the address refused.
`;

const SEE_HELP = "Run agent-lookout --help to see what it takes.";

function error(message: string): ParsedArguments {
  return { kind: "error", message: `${message} ${SEE_HELP}` };
}

/** The highest port number there is. */
const MAX_PORT = 65_535;

/** The port a `--port` value names, or null when it names none. */
function portNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  return port <= MAX_PORT ? port : null;
}

/** Reads the options of `start`. */
function parseStart(rest: readonly string[]): ParsedArguments {
  let port: number | null = null;
  let open = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    let value: string | undefined;
    if (arg === "--open") {
      open = true;
      continue;
    } else if (arg === "--port") {
      value = rest[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return error("--port needs a port number, such as 4778.");
      }
      index += 1;
    } else if (arg.startsWith("--port=")) {
      value = arg.slice("--port=".length);
      if (value === "") return error("--port needs a port number, such as 4778.");
    } else if (arg.startsWith("-")) {
      return error(`start has no option ${arg}.`);
    } else {
      return error(`start takes only options, not ${arg}.`);
    }
    port = portNumber(value);
    if (port === null) return error(`--port takes a number from 0 to ${MAX_PORT}, not ${value}.`);
  }
  return { kind: "start", options: { port, open } };
}

/**
 * Reads the arguments that follow the program's name. `--help` anywhere wins,
 * so it always works, whatever else was typed, and `--version` anywhere comes
 * next. With no command, or only options, it is `start`.
 */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv[0] === "help" || argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { kind: "help" };
  }
  if (argv.some((arg) => arg === "--version" || arg === "-v")) return { kind: "version" };

  const named = argv[0] !== undefined && !argv[0].startsWith("-");
  const command = named ? (argv[0] as string) : "start";
  const rest = named ? argv.slice(1) : argv;
  if (command === "start") return parseStart(rest);
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
