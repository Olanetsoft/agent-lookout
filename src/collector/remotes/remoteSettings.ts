// The other machines whose sessions are read over SSH, as
// `AGENT_LOOKOUT_REMOTES` names them. Pure: the environment is passed in.
//
// A target is handed to the person's own ssh as one argument after `--`, so a
// shell never reads it and ssh never takes it for an option. It is checked as
// strictly as if neither were true: a host alias, a host name or an address,
// with a user before an @ when one is given, and nothing else.

import { isMachineName, MAX_MACHINE_NAME_LENGTH } from "../../core/sessions/session.ts";

/** The variable that names the other machines. Unset, none is read. */
export const REMOTES_ENV = "AGENT_LOOKOUT_REMOTES";

/** Where Agent Lookout listens on the other machine unless a port is given: its own default. */
export const DEFAULT_REMOTE_PORT = 4777;

/** The most machines read at once. Each one is an ssh process of its own. */
export const MAX_REMOTES = 8;

/** One other machine. */
export interface Remote {
  /** Its name, shown beside its sessions: letters, digits and dashes. */
  name: string;
  /**
   * What ssh connects to: a host alias from the person's ssh config, a host
   * name or an address, or any of them after a user and an @.
   */
  target: string;
  /** The port Agent Lookout listens on there, on that machine's loopback. */
  port: number;
}

export type RemotesSetup = { on: true; remotes: Remote[] } | { on: false; problem: string | null };

/**
 * A user or a host as ssh takes it: letters, digits, dots, dashes and
 * underscores, starting with a letter, a digit or an underscore. So no space,
 * no leading dash, no @ or colon beyond the ones that part it, and nothing a
 * shell or ssh's own options would read.
 */
const USER = "[A-Za-z0-9_][A-Za-z0-9._-]{0,63}";
const HOST = "[A-Za-z0-9_][A-Za-z0-9._-]{0,252}";
const TARGET = new RegExp(`^(?:${USER}@)?${HOST}$`);

/** Whether text is a target Agent Lookout hands to ssh: `host`, `alias` or `user@host`. */
export function isSshTarget(value: string): boolean {
  return TARGET.test(value);
}

/** A port written as digits, from 1 to 65535, or null. */
function portOf(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** "1st", "2nd", "3rd", "4th": where an entry is in the list, for a sentence. */
function ordinal(index: number): string {
  const n = index + 1;
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}

const EXAMPLE = "such as devbox=dev@devbox.local";

/**
 * One entry, `name=target` or `name=target:port`, or the sentence saying why it
 * is not one. The sentence names the entry by its place, and the machine by
 * its name once that is a name, but never repeats a target: text that is not a
 * target has no place in a line on the console.
 */
function readEntry(entry: string, index: number): Remote | string {
  const equals = entry.indexOf("=");
  if (equals < 0) {
    return `${REMOTES_ENV} has an entry, the ${ordinal(index)}, with no = in it. Write each machine as name=target, ${EXAMPLE}.`;
  }
  const name = entry.slice(0, equals).trim();
  if (!isMachineName(name)) {
    return `${REMOTES_ENV} gives the ${ordinal(index)} machine a name that is not one: use letters, digits and dashes, up to ${MAX_MACHINE_NAME_LENGTH}, starting with a letter or a digit.`;
  }

  let target = entry.slice(equals + 1).trim();
  let port = DEFAULT_REMOTE_PORT;
  const colon = target.lastIndexOf(":");
  if (colon >= 0) {
    const given = portOf(target.slice(colon + 1));
    if (given === null) {
      return `${REMOTES_ENV} gives ${name} a port that is not a number from 1 to 65535.`;
    }
    port = given;
    target = target.slice(0, colon);
  }
  if (!isSshTarget(target)) {
    return `${REMOTES_ENV} gives ${name} a target that Agent Lookout does not hand to ssh. Give a host alias from your ssh config, a host name or user@host, with no spaces, no leading dash and no other punctuation.`;
  }
  return { name, target, port };
}

/**
 * Reads the other machines from the environment: a list of `name=target`
 * entries, each with `:port` after it when Agent Lookout listens on another
 * port there, separated by commas, such as
 * `devbox=dev@devbox.local,gpu=gpu-vm:4800`. Spaces around an entry, and an
 * entry left empty, are passed over.
 *
 * Unset or empty, no machine is read. One entry that cannot be read, two
 * machines of the same name, or more than eight, and none is: the setting is
 * taken as a whole, so a mistake in it is never half applied. The sentence
 * says what is wrong and never repeats a target. It never throws.
 */
export function readRemotesSetup(env: NodeJS.ProcessEnv): RemotesSetup {
  const value = env[REMOTES_ENV]?.trim() ?? "";
  if (value === "") return { on: false, problem: null };

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return { on: false, problem: null };
  if (entries.length > MAX_REMOTES) {
    return {
      on: false,
      problem: `${REMOTES_ENV} names ${entries.length} machines, and Agent Lookout reads ${MAX_REMOTES} at most.`,
    };
  }

  const remotes: Remote[] = [];
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const read = readEntry(entry, index);
    if (typeof read === "string") return { on: false, problem: read };
    // Two names that differ only in case would read as one beside a session.
    const key = read.name.toLowerCase();
    if (names.has(key)) {
      return { on: false, problem: `${REMOTES_ENV} names ${read.name} twice.` };
    }
    names.add(key);
    remotes.push(read);
  }
  return { on: true, remotes };
}

/** The line on the console that says the other machines are not read, and why. */
export function remotesProblemLine(problem: string): string {
  return `Other machines are not read: ${problem}`;
}
