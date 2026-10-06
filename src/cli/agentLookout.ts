// The `agent-lookout` command. `agent-lookout`, or `agent-lookout start`,
// starts Agent Lookout itself, as `npm start` does. `agent-lookout status`
// prints which sessions need you, from the Agent Lookout already running on
// this machine, and `agent-lookout mcp` serves the same to an agent. Those two
// start nothing. `bin/agent-lookout.mjs` loads this file, or the bundle built
// from it, and passes in the process's arguments, environment and output.

import type { Readable, Writable } from "node:stream";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

import type { HostProcess } from "../collector/hosts/standalone.ts";
import { readAppVersion } from "../collector/version.ts";

import { HELP, parseArguments } from "./arguments.ts";
import { addressesToTry, findSnapshot, readSessions, type Reading } from "./localServer.ts";
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
  /** The streams `mcp` speaks to its client over. Defaults to this process's stdin and stdout. */
  streams?: { stdin: Readable; stdout: Writable };
  /** The built dashboard `start` serves. The bin passes the `dist/` beside `bin/`. */
  distDir?: string;
  /** The process `start` stops with on Ctrl+C. Defaults to this one. */
  host?: HostProcess;
  /** Opens an address in the browser, for `start --open`. Defaults to the system's opener. */
  opener?: (url: string) => Promise<boolean>;
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
  if (parsed.kind === "version") {
    // From the package.json two folders up, in a clone as in the bundle in dist/cli/.
    stdout.write(`${readAppVersion()}\n`);
    return EXIT.nothingNeedsYou;
  }
  if (parsed.kind === "error") {
    say(parsed.message);
    return EXIT.notKnown;
  }

  if (parsed.kind === "start") {
    // Loaded here, so `status` never loads the collector and stays quick.
    const { startCommand } = await import("./start/startCommand.ts");
    const url = await startCommand({
      ...parsed.options,
      distDir: options.distDir ?? fileURLToPath(new URL("../../dist/", import.meta.url)),
      env: options.env,
      print: { log: (line) => stdout.write(`${line}\n`), error: say },
      process: options.host ?? process,
      opener: options.opener,
    });
    // Listening, it runs until Ctrl+C. A problem has already ended a real process with 1.
    return url === null ? 1 : 0;
  }

  const toTry = addressesToTry(parsed.options.url, options.env);
  if ("refusal" in toTry) {
    say(toTry.refusal);
    return EXIT.notKnown;
  }

  const read = options.read ?? ((address: string) => readSessions(address));
  const now = options.now ?? Date.now;

  if (parsed.kind === "mcp") {
    // Loaded here, so `status` never loads the protocol's library and stays quick.
    const { serveMcp } = await import("./mcp/mcpServer.ts");
    await serveMcp({
      addresses: toTry,
      read,
      now,
      ...(options.streams ?? { stdin: process.stdin, stdout: process.stdout }),
    });
    return 0;
  }

  const found = await findSnapshot(toTry, read);
  if (found.kind === "failed") {
    say(found.message);
    return EXIT.notKnown;
  }

  const report = statusReport(found.snapshot, now());
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
