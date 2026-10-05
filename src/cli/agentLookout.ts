// The `agent-lookout` command: `agent-lookout status` prints which sessions
// need you, from the Agent Lookout already running on this machine. It starts
// nothing. `bin/agent-lookout.mjs` loads this file and passes in the process's
// arguments, environment and output.

import { isatty } from "node:tty";

import { HELP, parseArguments } from "./arguments.ts";
import { addressesToTry, readSessions, type Reading } from "./localServer.ts";
import { statusCount, statusJson, statusReport, statusText } from "./statusReport.ts";

/** What the exit code says, so a script or a prompt can act on it without reading the output. */
export const EXIT = {
  nothingNeedsYou: 0,
  somethingNeedsYou: 1,
  notKnown: 2,
} as const;

export interface CommandOptions {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** Whether stdin and stdout are terminals. Defaults to asking the system about this process. */
  terminals?: { stdin: boolean; stdout: boolean };
  now?: () => number;
  /** Asks one address for its sessions. Defaults to a real request. */
  read?: (address: string) => Promise<Reading>;
}

/**
 * Whether tmux is running the command for a status line. tmux runs such a
 * command with `TMUX` set and with neither stdin nor stdout a terminal. Typed
 * in a tmux pane, its stdin is the terminal, even when its output is piped.
 */
export function runByTmux(options: Pick<CommandOptions, "env" | "terminals">): boolean {
  const terminals = options.terminals ?? { stdin: isatty(0), stdout: isatty(1) };
  return Boolean(options.env.TMUX) && !terminals.stdin && !terminals.stdout;
}

/** Runs the command and resolves with its exit code. Problems are one line on stderr. */
export async function runCommand(options: CommandOptions): Promise<number> {
  const { stdout, stderr } = options;
  const say = (line: string) => stderr.write(`${line}\n`);

  const parsed = parseArguments(options.argv);
  if (parsed.kind === "help") {
    stdout.write(HELP);
    return EXIT.nothingNeedsYou;
  }
  if (parsed.kind === "error") {
    say(parsed.message);
    return EXIT.notKnown;
  }

  const toTry = addressesToTry(parsed.options.url, options.env);
  if ("refusal" in toTry) {
    say(toTry.refusal);
    return EXIT.notKnown;
  }

  const read = options.read ?? ((address: string) => readSessions(address));
  let unreadable: { address: string; why: string } | null = null;
  for (const address of toTry.addresses) {
    const reading = await read(address);
    if (reading.kind === "answered") {
      const report = statusReport(reading.snapshot, (options.now ?? Date.now)());
      const output = parsed.options.output;
      stdout.write(
        output === "json"
          ? statusJson(report)
          : output === "count"
            ? statusCount(report)
            : statusText(report, runByTmux(options)),
      );
      // Until an agent has been read, no count was made, so a 0 would claim one.
      if (!report.counted) return EXIT.notKnown;
      return report.needsYou > 0 ? EXIT.somethingNeedsYou : EXIT.nothingNeedsYou;
    }
    if (reading.kind === "unreadable") unreadable ??= { address, why: reading.why };
  }

  if (unreadable) {
    say(`Agent Lookout could not be read at ${unreadable.address}: ${unreadable.why}.`);
  } else {
    const where = toTry.addresses.join(" or ");
    const elsewhere = toTry.named ? "" : ", or give its address with --url";
    say(
      `Agent Lookout is not running at ${where}. Start it with npm start or npm run dev in its folder${elsewhere}.`,
    );
  }
  return EXIT.notKnown;
}
