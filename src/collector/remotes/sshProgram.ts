// The person's own ssh, and the one way Agent Lookout runs it.

import path from "node:path";

import { isExecutableFile, pathCandidates, pathsOf } from "../files/paths.ts";
import type { Remote } from "./remoteSettings.ts";

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
 * no other, or else the first on `PATH`, then the fixed locations. On Windows
 * that is an `ssh.exe` on `PATH`, as the OpenSSH that comes with Windows puts
 * its folder there. Someone who
 * names a program means that program, so a mistake in the variable is reported
 * and another ssh is never run in its place.
 */
export async function findSsh(
  env: NodeJS.ProcessEnv,
  isExecutable?: (candidate: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform,
): Promise<SshSearch> {
  isExecutable ??= (candidate) => isExecutableFile(candidate, platform);
  const named = env[SSH_BIN_ENV]?.trim();
  if (named) {
    // The person chose this path themselves, so a relative one is taken as given.
    const resolved = pathsOf(platform).resolve(named);
    if (await isExecutable(resolved)) return { found: true, path: resolved };
    return {
      found: false,
      looked: `${SSH_BIN_ENV} is set to ${named}, which is not a program this user can run`,
      named: true,
    };
  }
  const candidates = [...new Set([...pathCandidates(env, "ssh", platform), ...SSH_LOCATIONS])];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return { found: true, path: candidate };
  }
  return {
    found: false,
    looked: `The ssh command was not found on PATH or in ${SSH_LOCATIONS.map((at) => path.dirname(at)).join(", ")}`,
  };
}

/**
 * Everything Agent Lookout gives ssh, in order:
 *
 * - `-W`: join ssh's input and output to the port Agent Lookout listens on
 *   there, on that machine's own 127.0.0.1, and run no command there. No port is
 *   opened on this computer. OpenSSH has it from 5.4, of 2010.
 * - `-o BatchMode=yes`: never ask for a password, a passphrase or whether to
 *   trust a host key. The person's ssh config and agent sign in, or the
 *   connection fails and says why.
 * - `-o ClearAllForwardings=yes`: none of the forwards the person's ssh config
 *   names for the host, so it never needs a port that an ssh of theirs holds,
 *   nor holds one that theirs needs. `-W` implies it, but the config can say no.
 * - `-o PermitLocalCommand=no`: no `LocalCommand` from the config, since it
 *   writes into ssh's output.
 * - `-o ServerAliveInterval=15`: notice within a minute that the other machine
 *   has gone, and end.
 * - `-o ControlMaster=no -o ControlPath=none`: a connection of its own, never
 *   one shared with another ssh through the person's `ControlMaster` and
 *   `ControlPath`, and never one left in the background by `ControlPersist`.
 *   So it ends when this process ends it. Options given here come before the
 *   person's ssh config.
 * - `--`, then the target, already checked by `isSshTarget`, so nothing in it is
 *   ever read as an option.
 */
export function sshArguments({ port, target }: Pick<Remote, "port" | "target">): string[] {
  return [
    "-W",
    `127.0.0.1:${port}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    `ServerAliveInterval=${SERVER_ALIVE_SECONDS}`,
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "--",
    target,
  ];
}
