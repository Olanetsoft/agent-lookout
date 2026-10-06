// The person's own ssh, and the one way Agent Lookout runs it.

import path from "node:path";

import { isExecutableFile, pathCandidates } from "../files/paths.ts";

/** The variable that names the ssh program outright. */
export const SSH_BIN_ENV = "AGENT_LOOKOUT_SSH_BIN";

/**
 * Where ssh is installed when it is not on `PATH`: the system's own on macOS
 * and Linux, then Homebrew's two homes. An app launched from the Finder or the
 * Dock does not inherit the shell's `PATH`, so without these it would never
 * find it.
 */
export const SSH_LOCATIONS = ["/usr/bin/ssh", "/opt/homebrew/bin/ssh", "/usr/local/bin/ssh"];

/**
 * How often ssh checks that the other machine is still there when nothing else
 * is said, in seconds. After three checks with no answer it gives up and ends,
 * and Agent Lookout starts it again.
 */
export const SERVER_ALIVE_SECONDS = 15;

export type SshSearch =
  | { found: true; path: string }
  | {
      found: false;
      /** Where it looked, in words that go inside a sentence. */
      looked: string;
      /** True when `AGENT_LOOKOUT_SSH_BIN` named a program that cannot be run. */
      named?: true;
    };

/**
 * Finds ssh: the program `AGENT_LOOKOUT_SSH_BIN` names when it is set, and then
 * no other, or else the first on `PATH`, then the fixed locations. Someone who
 * names a program means that program, so a mistake in the variable is reported
 * and another ssh is never run in its place.
 */
export async function findSsh(
  env: NodeJS.ProcessEnv,
  isExecutable: (candidate: string) => Promise<boolean> = isExecutableFile,
): Promise<SshSearch> {
  const named = env[SSH_BIN_ENV]?.trim();
  if (named) {
    // The person chose this path themselves, so a relative one is taken as given.
    const resolved = path.resolve(named);
    if (await isExecutable(resolved)) return { found: true, path: resolved };
    return {
      found: false,
      looked: `${SSH_BIN_ENV} is set to ${named}, which is not a program this user can run`,
      named: true,
    };
  }
  const candidates = [...new Set([...pathCandidates(env, "ssh"), ...SSH_LOCATIONS])];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return { found: true, path: candidate };
  }
  return {
    found: false,
    looked: `The ssh command was not found on PATH or in ${SSH_LOCATIONS.map((at) => path.dirname(at)).join(", ")}`,
  };
}

export interface SshForward {
  /** The port on this machine's 127.0.0.1 that leads to the other machine. */
  localPort: number;
  /** The port Agent Lookout listens on there, on that machine's own 127.0.0.1. */
  remotePort: number;
  /** What ssh connects to, already checked by `isSshTarget`. */
  target: string;
}

/**
 * Everything Agent Lookout gives ssh, in order:
 *
 * - `-N`: run no command there, only forward the port.
 * - `-o BatchMode=yes`: never ask for a password, a passphrase or whether to
 *   trust a host key. The person's ssh config and agent sign in, or the
 *   connection fails and says why.
 * - `-o ExitOnForwardFailure=yes`: end, rather than stay connected, when the
 *   port cannot be forwarded.
 * - `-o ServerAliveInterval=15`: notice within a minute that the other machine
 *   has gone, and end.
 * - `-o ControlMaster=no -o ControlPath=none`: a connection of its own, never
 *   one shared with another ssh through the person's `ControlMaster` and
 *   `ControlPath`, and never one left in the background by `ControlPersist`.
 *   So the forward belongs to this process, and ends when it ends. Options
 *   given here come before the person's ssh config.
 * - `-L`: a port on this machine's 127.0.0.1 to the one on that machine's
 *   127.0.0.1, so neither side listens anywhere but its own loopback.
 * - `--`, then the target, so nothing in it is ever read as an option.
 */
export function sshArguments(forward: SshForward): string[] {
  return [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ServerAliveInterval=${SERVER_ALIVE_SECONDS}`,
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-L",
    `127.0.0.1:${forward.localPort}:127.0.0.1:${forward.remotePort}`,
    "--",
    forward.target,
  ];
}
