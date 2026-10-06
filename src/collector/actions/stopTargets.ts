/**
 * What the collector acts on when the person presses Stop, or ends the
 * sessions left running: for each Claude Code session it can stop, the
 * process, the start time `ps` gave it and, for a background job, the job's
 * id. The Claude Code adapter finds them as it reads the registry, and the two
 * routes that stop sessions read them. None of it is ever sent to the page,
 * which is told only that a session can be stopped, and how: `StopOffer`.
 */

/** The variable that, set to `off`, takes Stop and the clean-up away altogether. */
export const STOP_ENV = "AGENT_LOOKOUT_STOP";

/** Whether `AGENT_LOOKOUT_STOP` is `off`, so no session is ever stopped from Agent Lookout. */
export function stopOff(env: NodeJS.ProcessEnv): boolean {
  return env[STOP_ENV]?.trim().toLowerCase() === "off";
}

/**
 * The shape of a background job's id, as `claude agents --json` prints it,
 * such as `7c5dcf5d`: letters, digits, dashes and underscores, starting with a
 * letter or a digit, so it can never be read as an option. An id of any other
 * shape is never handed to `claude stop`.
 */
export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;

interface Process {
  /** The session's own id, as its registry file gives it, without the source in front. */
  sessionId: string;
  pid: number;
  /** When the process started, as the registry file recorded what `ps` printed. */
  procStart: string;
  /** The registry file to read again before acting: `<claude home>/sessions/<pid>.json`. */
  registryFile: string;
}

/**
 * How one session is stopped:
 *
 * - `signal`: SIGTERM to its process, for a session in a terminal or in VS Code.
 * - `background`: `claude stop <jobId>`, for a background job, which Claude
 *   Code's supervisor would start again if its process were simply ended.
 */
export type StopTarget =
  (Process & { how: "signal" }) | (Process & { how: "background"; jobId: string });

export interface StopTargets {
  /** Replaces what is known with one poll's targets, by session id: `claude-code:<id>`. */
  set(targets: ReadonlyMap<string, StopTarget>): void;
  /** The target found for a session the collector lists, or undefined when it can not be stopped. */
  targetOf(sessionId: string): StopTarget | undefined;
  /**
   * Asks the adapter to run `claude agents` at its next poll, so a background
   * job that was stopped shows as stopped without waiting for the command's
   * beat.
   */
  askFeedSoon(): void;
  /** What `askFeedSoon` tells. The adapter that runs the command listens here. */
  onAskFeedSoon(listener: () => void): void;
}

export function createStopTargets(): StopTargets {
  let targets: ReadonlyMap<string, StopTarget> = new Map();
  const listeners: (() => void)[] = [];
  return {
    set(next) {
      targets = next;
    },
    targetOf: (sessionId) => targets.get(sessionId),
    askFeedSoon() {
      for (const listener of listeners) listener();
    },
    onAskFeedSoon(listener) {
      listeners.push(listener);
    },
  };
}
