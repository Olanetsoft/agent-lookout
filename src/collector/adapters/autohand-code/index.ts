import os from "node:os";
import path from "node:path";

import {
  autohandEndedAt,
  autohandStatusOf,
  chooseCandidate,
  CLOSE_SLACK_MS,
  effectiveMetadataStatus,
  heartbeatClass,
  importedAndNeverResumed,
  AUTOHAND_STALE_MS,
  type AutohandMode,
  type Candidate,
  type HeartbeatClass,
  type MetadataFacts,
  type MetadataStatus,
} from "../../../core/mapping/autohand-code/autohandCodeMapping.ts";
import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type {
  Session,
  SessionStatus,
  SourceCapabilities,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { plausibleTime } from "../../../core/time.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import {
  AUTOHAND_HOME_ENV,
  AUTOHAND_OWN_HOME_ENV,
  autohandHomeOf,
  effectiveUser,
  heartbeatsDirOf,
  isSessionFolderName,
  isTrusted,
  metadataPathOf,
  sessionsDirOf,
} from "./folders.ts";
import { createHeartbeatReader, type Heartbeat } from "./heartbeats.ts";
import { createMetadataReader, type MetadataRead } from "./metadata.ts";
import { autohandCodeSession, SOURCE_ID } from "./toSession.ts";

export { AUTOHAND_HOME_ENV, AUTOHAND_OWN_HOME_ENV, autohandHomeFor } from "./folders.ts";
export { SOURCE_ID } from "./toSession.ts";

/**
 * The Autohand Code adapter. Autohand Code is Autohand AI's terminal coding
 * agent, `autohand`, which rewrites a heartbeat for each running session and
 * keeps the details of each session in a folder of its own. See
 * docs/adapters/autohand-code.md. Built from Autohand Code's source at
 * v0.9.11 (Apache-2.0), and not yet checked on a computer running it.
 */

const LABEL = "Autohand Code";

/** How long a folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often every session's folder is looked up, for one last written over a day ago that was opened again. */
export const SWEEP_MS = 60_000;

/** How long a status is held over a late poll, for the heartbeat that is due to come. */
export const STAND_IN_MS = 7_000;

/** The usual way this adapter reads, named for the poller: the heartbeats and each session's `metadata.json`. */
export const BASIS = "files";

/**
 * The way it reads while the folder of heartbeats is missing, a link, another
 * user's or cannot be listed, when no session can be shown as working, idle
 * or needing you. Named apart, so every session does not seem to stop at once.
 */
export const BASIS_WITHOUT_HEARTBEATS = "files-without-heartbeats";

/** Said whenever Autohand Code is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "An Autohand Code session shows as needing you while Autohand Code asks you to approve a tool or to answer a question. Its other prompts, for a commit message, a folder outside the project, a plan or computer-use setup, show as working, and its offer to publish a research report shows as idle.";

/** Said whenever Autohand Code is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Autohand Code's source at v0.9.11 and has not yet been checked on a computer running it, so a status can be wrong.";

/** Said when a session's status is unknown. */
export const UNKNOWN_NOTE =
  "An Autohand Code session shows as unknown when its files cannot tell, as while it runs with --no-daemon or with its heartbeats moved, while its process runs but its heartbeat is over 15 seconds old, for up to 15 seconds after its process ends, and when it ended without closing while Agent Lookout was not running.";

/** Said when a heartbeat is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "An Autohand Code newer than this Agent Lookout wrote a heartbeat in a format it does not read, so that heartbeat is not read.";

/** Said when a heartbeat or a `metadata.json` is over the most this reads. */
export const TOO_LARGE_NOTE =
  "An Autohand Code heartbeat over 128 KiB, or a metadata.json over 1 MiB, is more than Agent Lookout reads, so it was not read.";

/** Said while the folder of heartbeats cannot be read. */
export function noHeartbeatsNote(folder: string): string {
  return `${folder} is missing, a link, another user's or could not be listed, so no Autohand Code session shows as working, idle or needing you. Autohand Code 0.9.3 or later writes a heartbeat there while a session runs.`;
}

/**
 * What an Autohand Code session can show, from the files this adapter reads
 * and signal 0. See docs/adapters/autohand-code.md for each. Built from
 * Autohand Code's source at v0.9.11 and not yet checked on a computer running
 * it.
 *
 * - Working and idle from a heartbeat written in the last 15 seconds whose
 *   process runs. A run with --no-daemon, or with its heartbeats moved, writes
 *   none here and shows as unknown.
 * - Needs you while the heartbeat says it waits for input, which Autohand
 *   Code writes while it asks you to approve a tool or to answer a question.
 * - Finished once Autohand Code closes the session, or the process of its
 *   last heartbeat goes or moves on to another session: at once when its
 *   heartbeat goes with it, else once that heartbeat is 15 seconds old.
 * - Failed when Autohand Code wrote `crashed` after an error in its loop and
 *   saved nothing after, once no fresh heartbeat shows it running. A failed
 *   -p run is written `completed`.
 * - Its name is yours, from `/rename` or `autohand --rename`, else its
 *   folder's. Autohand Code's own title is never read.
 * - No Jump yet.
 * - Quiet for is when its `metadata.json` was last written.
 * - No tokens, Stop or Answer.
 */
export const AUTOHAND_CODE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "From the heartbeat Autohand Code rewrites every 5 seconds. A run with --no-daemon, or with its heartbeats moved, shows as unknown.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "While Autohand Code asks you to approve a tool or answer a question. Some of its other prompts show as working.",
  },
  finished: {
    level: "partly",
    reason:
      "When closed, or soon after its process ends or leaves it. One that ended unclosed before Agent Lookout started is unknown.",
  },
  failed: {
    level: "partly",
    reason:
      "When marked crashed, with nothing saved since and no fresh heartbeat. A failed -p run is written completed and shows finished.",
  },
  names: {
    level: "partly",
    reason:
      "Your /rename or autohand --rename, else the folder's. Autohand Code's own title can be your first words, so it is never read.",
  },
  jump: {
    level: "no",
    reason: "Agent Lookout does not yet look for the terminal an Autohand Code session runs in.",
  },
  "quiet-for": {
    level: "partly",
    reason:
      "When Autohand Code last saved the session. Nothing is saved while a prompt waits or a tool runs.",
  },
  tokens: {
    level: "no",
    reason:
      "Autohand Code's files hold a session's running totals. A reply's own counts are in its conversation file, which is never opened.",
  },
  stop: {
    level: "no",
    reason: "Agent Lookout stops Claude Code sessions only so far.",
  },
  answer: {
    level: "no",
    reason:
      "Agent Lookout never connects to Autohand Code's peer socket or its RPC client, so it cannot send an answer.",
  },
};

/** Everything the adapter touches outside itself. Tests replace these. */
export interface AutohandCodeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** Whether a process runs, with signal 0, which tests a process and sends it nothing. */
  isAlive?: (pid: number) => boolean;
  /** The system's rules for folders and whether files' owners are checked. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** The user this runs as, whose files alone are read on macOS and Linux. Defaults to this one. */
  euid?: number | null;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often every session's folder is looked up. Defaults to a minute. */
  sweepMs?: number;
}

/** A heartbeat of a session on this poll, as its status is chosen from it. */
interface Seen extends Candidate {
  heartbeat: Heartbeat;
  alive: boolean;
}

/** What the adapter remembers of a session it shows, in memory only. No text is kept. */
interface Memory {
  /** Of the heartbeat chosen on the last poll that had one. */
  lastPid: number | null;
  lastMode: AutohandMode | null;
  lastUpdatedAt: number | null;
  lastClass: HeartbeatClass | null;
  lastWorkspaceRoot: string | null;
  lastStartedAt: number | null;
  /** When that poll was. */
  seenAt: number | null;
  /** What the last poll showed. */
  lastStatus: SessionStatus;
  lastStatusSince: number | null;
  /** Found ended: kept until a heartbeat comes back or the session is written to after. */
  ended: { at: number } | null;
  /** A status held over a late poll, from when. */
  standIn: { at: number; status: SessionStatus; statusSince: number | null } | null;
}

/** A session's folder this poll, with its `metadata.json`'s `lstat` when it has one this reads. */
type Folder = { metadata: FileInfo | null };

const BUSY: readonly SessionStatus[] = ["needs-you", "working", "idle"];

/**
 * Finds Autohand Code sessions on this machine from the files Autohand Code
 * keeps, with nothing installed, no setting changed and no Autohand Code
 * program run. Built from Autohand Code's source at v0.9.11 and not yet
 * checked on a computer running it.
 *
 * Each poll looks at the heartbeats in `active-agents` (`heartbeats.ts`), then
 * lists `sessions` and looks up each session's folder and its
 * `metadata.json` with `lstat`: those of the sessions shown, those a heartbeat
 * names, any new folder, and every other folder once a minute. A
 * `metadata.json` is opened (`metadata.ts`) only when it changed and its
 * session is shown: written in the last day, or named by a heartbeat of the
 * last day. A session shows only when it has a folder in `sessions`, so a run
 * with --ephemeral, which keeps nothing, is left out.
 *
 * Whether the process a heartbeat names runs is asked with signal 0, which
 * sends it nothing. Autohand Code deletes a stale heartbeat whenever any of its
 * sessions writes one, and a session that closes deletes its own first, so
 * what the adapter last saw of a session is kept in memory while it is shown:
 * a session whose last heartbeat's process has gone is finished, as is one
 * whose process went on to another session. That memory goes when Agent
 * Lookout stops.
 *
 * Autohand Code not being installed costs nothing: when neither folder is
 * there, the adapter says so and looks again only once a minute. Someone who
 * sets `AGENT_LOOKOUT_AUTOHAND_HOME` means that folder: if it holds neither,
 * that is an answer, not a missing Autohand Code.
 */
export function createAutohandCodeAdapter(options: AutohandCodeAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const isAlive = options.isAlive ?? isProcessAlive;
  const platform = options.platform ?? process.platform;
  const euid = options.euid === undefined ? effectiveUser() : options.euid;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const sweepMs = options.sweepMs ?? SWEEP_MS;

  const { home, from } = autohandHomeOf(env, homeDir, platform);
  const named = from === "agent-lookout";
  const heartbeatsDir = heartbeatsDirOf(home);
  const sessionsDir = sessionsDirOf(home);
  const homeName = tildify(home, homeDir);
  const heartbeatsName = tildify(heartbeatsDir, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);
  const heartbeats = createHeartbeatReader({ dir: heartbeatsDir, io, platform, euid, sweepMs });
  const metadata = createMetadataReader({ sessionsDir, io, platform, euid });

  /** When both folders were last found missing. Null while either is there, or before the first look. */
  let absentAt: number | null = null;
  /** When the last poll that read was, for a poll that comes late. */
  let previousAt: number | null = null;
  /** When every session's folder was last looked up. */
  let sweptAt: number | null = null;
  /** The folders last found to hold no session shown, looked up only by a sweep. */
  let settled = new Set<string>();
  let memory = new Map<string, Memory>();

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    sessions: Session[] = [],
    basis: string = BASIS,
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: [
        { label: "Heartbeats folder", value: heartbeatsName },
        { label: "Sessions folder", value: sessionsName },
        { label: "Read", value: read },
        { label: "Process check", value: `signal 0 alone, ${every(pollIntervalMs)}` },
      ],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis } : { health, sessions: [] };
  }

  /** Autohand Code is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    const neither = `there is no ${sessionsName} or ${heartbeatsName} folder`;
    const where =
      from === "autohand"
        ? `${AUTOHAND_OWN_HOME_ENV} is set to ${homeName}, and ${neither}`
        : neither;
    return result(
      "unavailable",
      `Autohand Code was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  function forgetAll() {
    previousAt = null;
    sweptAt = null;
    settled = new Set();
    memory = new Map();
    metadata.keepOnly(new Set());
  }

  /** Whether it is time to look up every session's folder. A clock set back counts as time enough. */
  function sweepDue(checkedAt: number): boolean {
    if (sweptAt === null) return true;
    const since = checkedAt - sweptAt;
    return since < 0 || since >= sweepMs;
  }

  /** A session's folder and its `metadata.json`, or null when no folder this reads is at its name. */
  async function lookUpFolder(id: string): Promise<Folder | null> {
    try {
      const info = await io.lstat(path.join(sessionsDir, id));
      if (!isTrusted(info, "session-folder", platform, euid)) return null;
    } catch {
      return null;
    }
    try {
      const info = await io.lstat(metadataPathOf(sessionsDir, id));
      return { metadata: isTrusted(info, "metadata", platform, euid) ? info : null };
    } catch {
      return { metadata: null };
    }
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Autohand Code is believed missing for a while, so a machine
    // without it pays nothing on most polls.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    // Signal 0 is asked at most once for each process on a poll.
    const answers = new Map<number, boolean>();
    const aliveOf = (pid: number): boolean => {
      let answer = answers.get(pid);
      if (answer === undefined) {
        answer = isAlive(pid);
        answers.set(pid, answer);
      }
      return answer;
    };

    const found = await heartbeats.read(checkedAt, aliveOf);
    let names: string[] | null;
    try {
      names = await io.readdir(sessionsDir);
    } catch (error) {
      if (!isMissing(error)) {
        return result(
          "error",
          `Autohand Code sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      names = null;
    }

    if (found.folder === "missing" && names === null) {
      forgetAll();
      if (named) {
        return result(
          "ok",
          `${AUTOHAND_HOME_ENV} is set to ${homeName}, which has no sessions or active-agents folder, so no Autohand Code sessions are listed. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`,
          "not found",
          checkedAt,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    const withHeartbeats = found.folder === "listed";
    const firstPoll = previousAt === null;
    const late =
      previousAt !== null &&
      (checkedAt - previousAt > AUTOHAND_STALE_MS || checkedAt - previousAt < 0);

    // Each session's heartbeats, and the sessions each process has a fresh one of.
    const bySession = new Map<string, Seen[]>();
    const freshOf = new Map<number, Set<string>>();
    for (const { name, heartbeat, alive } of found.found) {
      const seen: Seen = {
        name,
        pid: heartbeat.pid,
        updatedAt: heartbeat.updatedAt,
        phase: heartbeat.phase,
        heartbeatClass: heartbeatClass(heartbeat.updatedAt, alive, checkedAt),
        heartbeat,
        alive,
      };
      const list = bySession.get(heartbeat.sessionId) ?? [];
      list.push(seen);
      bySession.set(heartbeat.sessionId, list);
      if (seen.heartbeatClass === "fresh") {
        const sessions = freshOf.get(heartbeat.pid) ?? new Set<string>();
        sessions.add(heartbeat.sessionId);
        freshOf.set(heartbeat.pid, sessions);
      }
    }

    // The folders due a look: every one not settled, those a heartbeat or
    // the memory names, and all of them on a sweep.
    const sweep = sweepDue(checkedAt);
    if (sweep) sweptAt = checkedAt;
    const stillSettled = new Set<string>();
    const folders = new Map<string, Folder>();
    for (const id of (names ?? []).filter(isSessionFolderName).sort()) {
      if (settled.has(id) && !sweep && !bySession.has(id) && !memory.has(id)) {
        stillSettled.add(id);
        continue;
      }
      const folder = await lookUpFolder(id);
      if (folder !== null) folders.set(id, folder);
    }

    const sessions: Session[] = [];
    const nextMemory = new Map<string, Memory>();
    const read = new Set<string>();
    let unknown = false;
    let tooLarge = found.tooLarge;

    for (const [id, folder] of folders) {
      const seen = bySession.get(id) ?? [];
      const before = memory.get(id);
      const recently = (at: number | null) => at !== null && isWithinRetention(at, checkedAt);
      const lstatWrittenAt = folder.metadata === null ? null : Math.floor(folder.metadata.mtimeMs);
      const namedRecently =
        seen.some((one) => recently(one.updatedAt)) || recently(before?.lastUpdatedAt ?? null);

      let md: MetadataRead | null = null;
      if (folder.metadata !== null && (namedRecently || recently(lstatWrittenAt))) {
        md = await metadata.read(id, folder.metadata);
        read.add(id);
        if (md.state === "too-large") tooLarge = true;
      }
      const facts: MetadataFacts | null = md?.state === "ok" ? md.facts : null;
      const writtenAt = md?.state === "ok" ? Math.floor(md.writtenAt) : lstatWrittenAt;

      // A copy from another tool or the web that you never resumed.
      if (facts !== null && importedAndNeverResumed(facts) && seen.length === 0) {
        stillSettled.add(id);
        continue;
      }

      const effective =
        facts === null ? null : effectiveMetadataStatus(facts, writtenAt, checkedAt);
      const shownMetadata: MetadataStatus | "unreadable" | null =
        effective ?? (md !== null || folder.metadata !== null ? "unreadable" : null);
      const chosen = chooseCandidate(seen);

      // Found ended, until a heartbeat comes back or it is written to after.
      let ended = before?.ended ?? null;
      if (
        ended !== null &&
        (seen.length > 0 || (facts?.lastActiveAt ?? -Infinity) > ended.at + CLOSE_SLACK_MS)
      ) {
        ended = null;
      }

      const lastPid = before?.lastPid ?? null;
      const movedOn =
        chosen === null &&
        lastPid !== null &&
        (before?.lastMode === "interactive" || before?.lastMode === "command") &&
        [...(freshOf.get(lastPid) ?? [])].some((other) => other !== id);

      // A late poll, as after the computer slept, holds the status before for
      // a moment, for the heartbeat that is due, while its process runs.
      let standIn: Memory["standIn"] = null;
      if (withHeartbeats && before !== undefined && chosen?.heartbeatClass !== "fresh") {
        const held = before.standIn;
        const holds = held !== null && checkedAt >= held.at && checkedAt <= held.at + STAND_IN_MS;
        const starts =
          held === null &&
          late &&
          before.lastClass === "fresh" &&
          before.seenAt === previousAt &&
          (chosen === null || chosen.heartbeatClass === "quiet");
        const closedSince =
          facts?.closedAt != null &&
          before.lastUpdatedAt !== null &&
          facts.closedAt > before.lastUpdatedAt;
        if ((holds || starts) && !closedSince && lastPid !== null && aliveOf(lastPid)) {
          standIn = holds
            ? held
            : { at: checkedAt, status: before.lastStatus, statusSince: before.lastStatusSince };
        }
      }

      const lastProcessGone =
        chosen === null && !movedOn && ended === null && lastPid !== null && !aliveOf(lastPid);
      const { status, waitingReason, row } = autohandStatusOf({
        chosen,
        metadata: shownMetadata,
        movedOn,
        standIn: standIn?.status ?? null,
        ended: ended !== null,
        lastProcessGone,
      });
      if ((status === "finished" || status === "failed") && [5, 9, 10, 11].includes(row)) {
        ended ??= { at: checkedAt };
      }

      let statusSince: number | null = null;
      if (standIn !== null) {
        statusSince = standIn.statusSince;
      } else if (BUSY.includes(status)) {
        if (before?.lastStatus === status) statusSince = before.lastStatusSince;
        else if (!firstPoll) statusSince = plausibleTime(chosen?.updatedAt ?? null, checkedAt);
      } else if (status === "finished" || status === "failed") {
        statusSince = autohandEndedAt({
          facts,
          effective,
          writtenAt,
          updatedAt: chosen?.updatedAt ?? before?.lastUpdatedAt ?? null,
          now: checkedAt,
        });
      }

      const listed =
        chosen?.heartbeatClass === "fresh" ||
        standIn !== null ||
        recently(chosen?.updatedAt ?? null) ||
        recently(before?.lastUpdatedAt ?? null) ||
        recently(writtenAt);
      if (!listed) {
        stillSettled.add(id);
        continue;
      }

      const heartbeat = chosen?.heartbeat;
      nextMemory.set(id, {
        lastPid: heartbeat?.pid ?? lastPid,
        lastMode: heartbeat === undefined ? (before?.lastMode ?? null) : heartbeat.mode,
        lastUpdatedAt:
          heartbeat === undefined ? (before?.lastUpdatedAt ?? null) : heartbeat.updatedAt,
        lastClass: chosen?.heartbeatClass ?? before?.lastClass ?? null,
        lastWorkspaceRoot: heartbeat?.workspaceRoot ?? before?.lastWorkspaceRoot ?? null,
        lastStartedAt: heartbeat?.startedAt ?? before?.lastStartedAt ?? null,
        seenAt: chosen === null ? (before?.seenAt ?? null) : checkedAt,
        lastStatus: status,
        lastStatusSince: statusSince,
        ended,
        standIn,
      });
      if (status === "unknown") unknown = true;
      sessions.push(
        autohandCodeSession({
          sessionId: id,
          status,
          ...(waitingReason === undefined ? {} : { waitingReason }),
          statusSince,
          facts,
          writtenAt,
          heartbeat:
            heartbeat === undefined && before === undefined
              ? null
              : {
                  workspaceRoot: heartbeat?.workspaceRoot ?? before?.lastWorkspaceRoot ?? null,
                  mode: heartbeat === undefined ? (before?.lastMode ?? null) : heartbeat.mode,
                  startedAt: heartbeat?.startedAt ?? before?.lastStartedAt ?? null,
                },
          process: chosen === null ? null : { pid: chosen.pid, alive: chosen.alive },
          now: checkedAt,
        }),
      );
    }

    settled = stillSettled;
    memory = nextMemory;
    metadata.keepOnly(read);
    previousAt = checkedAt;

    const basis = withHeartbeats ? BASIS : BASIS_WITHOUT_HEARTBEATS;
    let detail = `Sessions are read from the heartbeats Autohand Code rewrites in ${heartbeatsName} while each runs, and the metadata.json it keeps for each in ${sessionsName}. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;
    if (unknown) detail += ` ${UNKNOWN_NOTE}`;
    if (!withHeartbeats) detail += ` ${noHeartbeatsNote(heartbeatsName)}`;
    if (found.newer) detail += ` ${NEWER_FORMAT_NOTE}`;
    if (tooLarge) detail += ` ${TOO_LARGE_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions, basis);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: AUTOHAND_CODE_CAPABILITIES,
    lookingIn: `Looking for Autohand Code sessions in ${homeName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Autohand Code sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
