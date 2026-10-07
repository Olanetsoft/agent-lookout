// Opening Agent Lookout's address in the default browser, for `--open`.
//
// The system's own opener is run directly, never through a shell, with the
// one argument: the address the server listens on. Only an http address on
// this machine is handed over, so nothing else can reach that command line.

import { spawn } from "node:child_process";
import path from "node:path";

import { childEnvironment } from "../../collector/processes/childEnvironment.ts";
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

/** Where Windows keeps itself when nothing says otherwise. */
const WINDOWS_FOLDER = "C:\\Windows";

/** The Windows folder, from `SystemRoot`, when that is a whole path. */
function windowsFolder(env: NodeJS.ProcessEnv): string {
  const named = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim();
  return named && path.win32.isAbsolute(named) ? named : WINDOWS_FOLDER;
}

/**
 * The command that opens an address in the default browser: `open` on macOS,
 * by its full path, `xdg-open` on Linux, and on Windows the system's own
 * `rundll32.exe`, by its full path, handing the address to the program
 * Windows opens web addresses with. Null on a system with none of them, or for
 * an address that is not Agent Lookout's own on this machine.
 */
export function openCommand(
  platform: NodeJS.Platform,
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): OpenCommand | null {
  const address = loopbackAddress(url);
  if (address === null) return null;
  if (platform === "darwin") return { file: "/usr/bin/open", args: [address] };
  if (platform === "linux") return { file: "xdg-open", args: [address] };
  if (platform === "win32") {
    return {
      file: path.win32.join(windowsFolder(env), "System32", "rundll32.exe"),
      args: ["url.dll,FileProtocolHandler", address],
    };
  }
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
      const child = spawn(file, [...args], {
        env: childEnvironment(process.env),
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
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
  /** Where `SystemRoot` is read, on Windows. Defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  run?: RunProgram;
}

/** Opens the address in the default browser. Resolves with whether that worked. Never rejects. */
export async function openInBrowser(url: string, options: OpenOptions = {}): Promise<boolean> {
  const command = openCommand(options.platform ?? process.platform, url, options.env);
  if (command === null) return false;
  return (options.run ?? runProgram)(command.file, command.args);
}
