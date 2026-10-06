// Opening Agent Lookout's address in the default browser, for `--open`.
//
// The system's own opener is run directly, never through a shell, with the
// one argument: the address the server listens on. Only an http address on
// this machine is handed over, so nothing else can reach that command line.

import { spawn } from "node:child_process";

import { loopbackAddress } from "../localServer.ts";

/** A program and its arguments, run directly. */
export interface OpenCommand {
  file: string;
  args: string[];
}

/** Runs a program and resolves with whether it handed the address over. Never rejects. */
export type RunProgram = (file: string, args: readonly string[]) => Promise<boolean>;

/** How long the opener is waited for, to tell whether it failed, before it counts as having worked. */
export const OPEN_WAIT_MS = 10_000;

/**
 * The command that opens an address in the default browser: `open` on macOS,
 * by its full path, and `xdg-open` on Linux. Null on a system with neither, or
 * for an address that is not Agent Lookout's own on this machine.
 */
export function openCommand(platform: NodeJS.Platform, url: string): OpenCommand | null {
  const address = loopbackAddress(url);
  if (address === null) return null;
  if (platform === "darwin") return { file: "/usr/bin/open", args: [address] };
  if (platform === "linux") return { file: "xdg-open", args: [address] };
  return null;
}

/**
 * Runs a program with no shell, with nothing connected to its input or output,
 * and in a session of its own, so Ctrl+C for Agent Lookout never reaches it or
 * a browser it starts. It is never stopped: `xdg-open` with no desktop's own
 * opener runs the browser in the foreground, and ends only when the browser
 * quits. So it has worked when it ends with 0, or is still running after
 * `waitMs`, and has failed when it cannot be run or ends with any other code.
 */
export function runProgram(
  file: string,
  args: readonly string[],
  waitMs = OPEN_WAIT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const settle = (opened: boolean) => {
      clearTimeout(timer);
      resolve(opened);
    };
    try {
      const child = spawn(file, [...args], { stdio: "ignore", detached: true });
      child.once("error", () => settle(false));
      child.once("exit", (code) => settle(code === 0));
      // Agent Lookout may stop while the opener still runs.
      child.unref();
      timer = setTimeout(() => settle(true), waitMs);
    } catch {
      settle(false);
    }
  });
}

export interface OpenOptions {
  platform?: NodeJS.Platform;
  run?: RunProgram;
}

/** Opens the address in the default browser. Resolves with whether that worked. Never rejects. */
export async function openInBrowser(url: string, options: OpenOptions = {}): Promise<boolean> {
  const command = openCommand(options.platform ?? process.platform, url);
  if (command === null) return false;
  return (options.run ?? runProgram)(command.file, command.args);
}
