// The other machines `AGENT_LOOKOUT_REMOTES` names, in one piece: a tunnel
// and a source for each, started and stopped with the collector.

import { remoteSourceId } from "../../core/sessions/session.ts";
import type { Adapter } from "../adapters/adapter.ts";
import { waitingTextOff } from "../adapters/claude-code/transcript/waitingTexts.ts";
import { createRemoteAdapter } from "./remoteAdapter.ts";
import type { RemoteReading } from "./remoteReader.ts";
import { readRemotesSetup, REMOTES_ENV, type Remote } from "./remoteSettings.ts";
import { createTunnel, type TunnelOptions } from "./tunnel.ts";

/**
 * The source that stands for the other machines while `AGENT_LOOKOUT_REMOTES`
 * cannot be read: `remote:`, with no machine's name after it, since none is
 * read. It has no sessions.
 */
export const REMOTES_SETTING_SOURCE_ID = remoteSourceId("");

/**
 * The card that says why no other machine is read, in Sources: "Other
 * machines", not set up, with the sentence the console says. Someone who
 * started the Mac app sees no console, and would otherwise never learn why.
 */
function settingAdapter(problem: string, now: () => number): Adapter {
  return {
    id: REMOTES_SETTING_SOURCE_ID,
    label: "Other machines",
    async poll() {
      return {
        health: {
          id: REMOTES_SETTING_SOURCE_ID,
          label: "Other machines",
          state: "not-set-up",
          detail: problem,
          advice: `Correct ${REMOTES_ENV}, or unset it, and start Agent Lookout again. Until then no other machine is read and ssh is never run.`,
          watching: [{ label: "Setting", value: REMOTES_ENV }],
          checkedAt: now(),
        },
        sessions: [],
      };
    },
  };
}

export interface RemotesOptions {
  /** Where `AGENT_LOOKOUT_REMOTES` is read, and what ssh is found in and run with. */
  env: NodeJS.ProcessEnv;
  /** This machine's version of Agent Lookout. */
  version: string;
  now?: () => number;
  pollIntervalMs?: number;
  /** How ssh is run and started again. Tests shorten the waits. */
  tunnels?: Omit<TunnelOptions, "remote" | "env" | "now">;
  /** Reads the other machine through its tunnel. Tests pass their own. */
  read?: (port: number) => Promise<RemoteReading>;
}

export interface Remotes {
  /** The machines read, in the order the setting names them. */
  remotes: readonly Remote[];
  /**
   * A source for each, to poll with the others. When the setting cannot be
   * read, one source that says why, with no sessions, and no machine.
   */
  adapters: readonly Adapter[];
  /** Why none is read when the setting is wrong, or null. */
  problem: string | null;
  /** Starts every tunnel. */
  start(): void;
  /** Stops every tunnel. Resolves once each ssh has ended. */
  stop(): Promise<void>;
}

/**
 * The other machines to read, from the environment. With
 * `AGENT_LOOKOUT_REMOTES` unset there are none, and ssh is never looked for.
 * With it set and wrong there are none either, and one source says why.
 */
export function createRemotes(options: RemotesOptions): Remotes {
  const setup = readRemotesSetup(options.env);
  const remotes = setup.on ? setup.remotes : [];
  // What a waiting session asks, turned off here, is not shown for one there either.
  const waitingText = !waitingTextOff(options.env);
  const tunnels = remotes.map((remote) =>
    createTunnel({ remote, env: options.env, now: options.now, ...options.tunnels }),
  );
  const adapters = remotes.map((remote, index) =>
    createRemoteAdapter({
      remote,
      tunnel: tunnels[index] as (typeof tunnels)[number],
      version: options.version,
      read: options.read,
      now: options.now,
      pollIntervalMs: options.pollIntervalMs,
      waitingText,
    }),
  );
  const problem = setup.on ? null : setup.problem;
  return {
    remotes,
    adapters: problem === null ? adapters : [settingAdapter(problem, options.now ?? Date.now)],
    problem,
    start() {
      for (const tunnel of tunnels) tunnel.start();
    },
    async stop() {
      await Promise.all(tunnels.map((tunnel) => tunnel.stop()));
    },
  };
}
