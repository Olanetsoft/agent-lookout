// Another machine as a source: its sessions, read through its tunnel on every
// poll, and its card in the Sources view, which says whether it is connected
// and, when it is not, why.

import {
  remoteSourceId,
  SOURCE_STATE_LABEL,
  type AgentCapabilities,
  type Session,
  type SourceFact,
  type SourceHealth,
  type SourceState,
} from "../../core/sessions/session.ts";
import type { Adapter, AdapterResult } from "../adapters/adapter.ts";
import { every } from "../adapters/words.ts";
import { POLL_INTERVAL_MS } from "../poller.ts";
import { readRemote, REMOTE_ANSWER_TIMEOUT_MS, type RemoteReading } from "./remoteReader.ts";
import { readRemoteSnapshot, type RemoteSnapshot } from "./remoteSessions.ts";
import type { Remote } from "./remoteSettings.ts";
import { SSH_BIN_ENV } from "./sshProgram.ts";
import type { Tunnel, TunnelEnd } from "./tunnel.ts";

/** The one way a machine is read, named for the poller. */
export const BASIS = "api";

/**
 * The state of a machine that is not connected, whatever the reason. It is
 * `unavailable`, as a tool that is not on this computer is, and not `error`:
 * a machine that is switched off overnight is not a fault of this computer.
 * So the Overview raises no notice for it while this computer's own sources
 * are read, and says only, in plain words, that its sessions are not known;
 * the history goes on being kept, after one gap, without its sessions, and
 * none of its sessions is said to have ended. The Sources view says why.
 */
export const NOT_CONNECTED = "unavailable" satisfies SourceState;

/**
 * How long a poll waits for a reading under way. A reading that takes longer
 * is used by the next poll, so another machine on a slow link never holds up
 * this machine's own sessions.
 */
export const ANSWER_WAIT_MS = 500;

/**
 * How long the first connection is said to be under way before the card says
 * it is not connected yet. ssh can take a minute or more to give up on a
 * machine that is switched off, and until then nothing is known of its
 * sessions, so the Overview is not left looking for them all that time.
 */
export const STILL_CONNECTING_MS = 10_000;

export interface RemoteAdapterOptions {
  remote: Remote;
  tunnel: Pick<Tunnel, "state" | "connected">;
  /** This machine's version of Agent Lookout, to say when the other's cannot be read. */
  version: string;
  /** Reads the other machine through the tunnel's port. Tests pass their own. */
  read?: (port: number) => Promise<RemoteReading>;
  now?: () => number;
  pollIntervalMs?: number;
  /** Defaults to `ANSWER_WAIT_MS`. */
  answerWaitMs?: number;
  /** Defaults to `STILL_CONNECTING_MS`. */
  stillConnectingMs?: number;
  /**
   * Whether what a waiting session there is asking is shown. False with
   * `AGENT_LOOKOUT_WAITING_TEXT=off` on this computer. Defaults to true.
   */
  waitingText?: boolean;
}

/** Resolves when the work is done, or after `ms`, whichever is first. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void work.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A sentence from ssh, ending as a sentence does. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** "in 1 second", "in 30 seconds": how long until the next try. */
function inSeconds(at: number, now: number): string {
  const seconds = Math.max(1, Math.ceil((at - now) / 1000));
  return `in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** What went wrong, and what to do about it, as the card says it. */
interface Problem {
  detail: string;
  advice?: string;
}

/** What one completed reading came to, for the run it was read through. */
interface Read {
  run: number;
  at: number;
  reading: RemoteReading;
  /** The sessions and sources it held, once read. */
  snapshot: RemoteSnapshot | null;
}

/**
 * One other machine, as a source of sessions.
 *
 * Every poll it reads that machine's `/api/health` and `/api/sessions`
 * through the tunnel, and waits half a second for the answer: a slower one is
 * used by the poll after. Its sessions are listed with the machine's name on
 * each, as `readRemoteSnapshot` makes them, with no Jump, no Stop and no
 * request to answer.
 *
 * Its card says one of:
 *
 * - connecting, while ssh signs in the first time, for ten seconds, and then
 *   still connecting, as not connected, until it does or gives up;
 * - connected, with the version of Agent Lookout there and the state of each
 *   source it watches;
 * - or why not: ssh is not found, the other machine turned ssh away, the
 *   connection dropped, no Agent Lookout answers on its port there, or what
 *   answers there is not Agent Lookout or sends a list this version cannot
 *   read. While ssh is started again, the card keeps the reason and says so.
 *
 * A machine that is not connected is `unavailable`, for the reasons
 * `NOT_CONNECTED` gives, so while it is, nothing of its sessions is said to
 * have ended.
 */
export function createRemoteAdapter(options: RemoteAdapterOptions): Adapter {
  const { remote, tunnel, version } = options;
  const read = options.read ?? ((port: number) => readRemote(port));
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const answerWaitMs = options.answerWaitMs ?? ANSWER_WAIT_MS;
  const stillConnectingMs = options.stillConnectingMs ?? STILL_CONNECTING_MS;
  const waitingText = options.waitingText ?? true;
  const id = remoteSourceId(remote.name);
  const label = remote.name;
  const where = `port ${remote.port} of ${remote.name}`;

  /** The latest reading of the running tunnel. */
  let latest: Read | null = null;
  /** The reading under way, if one is. */
  let underWay: Promise<void> | null = null;
  /** What went wrong last, until a reading comes back whole. */
  let problem: Problem | null = null;
  /** What each agent there can report, as last read. It stays while the machine cannot be read. */
  let agents: AgentCapabilities[] = [];
  /** The command the tunnel last ran. */
  let command: string | null = null;
  /** When connecting began, the first time or since the last reading came back whole. */
  let connectingSince: number | null = null;

  function facts(snapshot: RemoteSnapshot | null, remoteVersion: string | null): SourceFact[] {
    const watching: SourceFact[] = [{ label: "Connects to", value: remote.target }];
    if (command !== null) watching.push({ label: "Command", value: command });
    watching.push(
      { label: "Asks for", value: "/api/health and /api/sessions" },
      { label: "Read", value: every(pollIntervalMs) },
    );
    if (remoteVersion !== null) {
      watching.push({ label: "Agent Lookout there", value: remoteVersion });
    }
    for (const source of snapshot?.sources ?? []) {
      watching.push({ label: `${source.label} there`, value: SOURCE_STATE_LABEL[source.state] });
    }
    return watching;
  }

  function result(
    state: SourceState,
    found: Problem,
    checkedAt: number,
    snapshot: RemoteSnapshot | null = null,
    remoteVersion: string | null = null,
  ): AdapterResult {
    const health: SourceHealth = {
      id,
      label,
      machine: remote.name,
      state,
      detail: found.detail,
      watching: facts(snapshot, remoteVersion),
      checkedAt,
    };
    if (found.advice) health.advice = found.advice;
    if (agents.length > 0) health.agents = agents;
    const sessions: Session[] = state === "ok" && snapshot ? snapshot.sessions : [];
    return state === "ok" ? { health, sessions, basis: BASIS } : { health, sessions };
  }

  /**
   * While ssh signs in: searching the first time, for ten seconds, and then
   * not connected yet, so a machine that does not answer is not looked for
   * for as long as ssh takes to give up. After a problem, that problem.
   */
  function connecting(at: number): AdapterResult {
    if (problem === null) {
      connectingSince ??= at;
      if (at - connectingSince < stillConnectingMs) {
        return result(
          "searching",
          { detail: `Connecting to ${remote.name} over SSH, as ${remote.target}.` },
          at,
        );
      }
      return result(
        NOT_CONNECTED,
        {
          detail: `Still connecting to ${remote.name} over SSH, as ${remote.target}.`,
          advice: `ssh has not connected yet. If this goes on, check that ssh ${remote.target} connects from a terminal on this computer, and that ${remote.name} is switched on and reachable.`,
        },
        at,
      );
    }
    return result(
      NOT_CONNECTED,
      { detail: `${problem.detail} Connecting again.`, advice: problem.advice },
      at,
    );
  }

  /** Why a run of ssh ended, in words. */
  function endProblem(end: TunnelEnd): Problem {
    const said = end.said === null ? null : sentence(end.said);
    if (end.connected) {
      return {
        detail: `The SSH connection to ${remote.name} dropped${said ? `: ${said}` : "."}`,
        advice:
          "It is started again on its own. If it keeps dropping, check the network between the two machines.",
      };
    }
    if (said !== null && /could not request local forwarding|cannot listen to port/i.test(said)) {
      return { detail: `ssh could not forward a port on this computer: ${said}` };
    }
    if (
      said !== null &&
      /permission denied|host key verification failed|authentication|refused|closed by/i.test(said)
    ) {
      return {
        detail: `${remote.name} turned the SSH connection away: ${said}`,
        advice: `Check that ssh ${remote.target} connects without asking for anything. Agent Lookout runs ssh with BatchMode, so it never types a password or answers a question.`,
      };
    }
    return {
      detail: said
        ? `ssh could not connect to ${remote.target}: ${said}`
        : `ssh could not connect to ${remote.target}, and ended${end.code === null ? "" : ` with code ${end.code}`}.`,
      advice: `Check that ssh ${remote.target} connects from a terminal on this computer.`,
    };
  }

  /** What a reading that came back says, for the card. */
  function fromRead(done: Read): AdapterResult {
    const { reading } = done;
    switch (reading.kind) {
      case "refused":
        return connecting(done.at);
      case "closed":
        problem = {
          detail: `ssh is connected to ${remote.name}, but no Agent Lookout answers on its port ${remote.port}.`,
          advice: `Start it there with npx agent-lookout, and leave it running. If it listens on another port, give it as ${remote.name}=${remote.target}:<port>.`,
        };
        return result(NOT_CONNECTED, problem, done.at);
      case "timeout":
        problem = {
          detail: `${remote.name} did not answer within ${REMOTE_ANSWER_TIMEOUT_MS / 1000} seconds.`,
          advice: "It keeps trying. ssh notices within a minute when the connection has gone.",
        };
        return result(NOT_CONNECTED, problem, done.at);
      case "unreadable":
        problem = {
          detail: `What listens on ${where} ${reading.why}, so it is not read as Agent Lookout.`,
          advice: `Check that Agent Lookout is what listens there, or give its port as ${remote.name}=${remote.target}:<port>.`,
        };
        return result(NOT_CONNECTED, problem, done.at);
      case "read":
        if (done.snapshot === null) {
          problem = {
            detail: `${remote.name} runs Agent Lookout ${reading.version}, and this computer's, ${version}, cannot read its list of sessions.`,
            advice: "Run the same version of Agent Lookout on both machines.",
          };
          return result(NOT_CONNECTED, problem, done.at, null, reading.version);
        }
        problem = null;
        connectingSince = null;
        return result(
          "ok",
          {
            detail: `Sessions are read from Agent Lookout ${reading.version} on ${remote.name}, through ssh to ${remote.target}. Jump, Stop, Allow and Deny act on this computer only.`,
          },
          done.at,
          done.snapshot,
          reading.version,
        );
    }
  }

  /** Starts a reading through this run, unless one is under way. */
  function readThrough(run: number, port: number): Promise<void> {
    if (underWay) return underWay;
    const current = read(port)
      .catch((): RemoteReading => ({ kind: "closed" }))
      .then((reading) => {
        const at = now();
        // Anything but a refusal came through ssh, so ssh had signed in.
        if (reading.kind !== "refused") tunnel.connected(run);
        const snapshot =
          reading.kind === "read"
            ? readRemoteSnapshot(reading.snapshot, remote.name, at, { waitingText })
            : null;
        if (snapshot) agents = snapshot.agents;
        latest = { run, at, reading, snapshot };
      })
      .finally(() => {
        underWay = null;
      });
    underWay = current;
    return current;
  }

  async function poll(): Promise<AdapterResult> {
    const at = now();
    const state = tunnel.state();
    switch (state.kind) {
      case "off":
        return connecting(at);
      case "no-ssh":
        latest = null;
        problem = {
          detail: `${state.looked}, so ${remote.name} cannot be reached. Looking again ${inSeconds(state.retryAt, at)}.`,
          advice: state.named
            ? `Correct ${SSH_BIN_ENV}, or unset it to use the ssh on your PATH.`
            : `Install OpenSSH, or name the ssh program with ${SSH_BIN_ENV}.`,
        };
        return result(NOT_CONNECTED, problem, at);
      case "ended": {
        // What it held belongs to that run, and a waiting session's text to its wait.
        latest = null;
        problem = endProblem(state.end);
        return result(
          NOT_CONNECTED,
          {
            detail: `${problem.detail} Trying again ${inSeconds(state.retryAt, at)}.`,
            advice: problem.advice,
          },
          at,
        );
      }
      case "running": {
        command = state.command.join(" ");
        if (latest && latest.run !== state.run) latest = null;
        await within(readThrough(state.run, state.port), answerWaitMs);
        return latest && latest.run === state.run ? fromRead(latest) : connecting(at);
      }
    }
  }

  return {
    id,
    label,
    lookingIn: `Connecting to ${remote.name} over SSH, as ${remote.target}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        return result(
          "error",
          { detail: `Something unexpected went wrong while reading ${remote.name}.` },
          now(),
        );
      }
    },
  };
}
