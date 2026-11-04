import os from "node:os";
import path from "node:path";

import { isOpenClineStatus } from "../../../core/mapping/cline/clineMapping.ts";
import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import { START_CHECK_TTL_MS, type ReadProcessStarts } from "../../processes/processStart.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { createRecordProcessCheck, type RecordProcess } from "../qwen-code/processCheck.ts";
import { every } from "../words.ts";
import {
  createManifestReader,
  isSessionFolderName,
  manifestPath,
  messagesPath,
  type Manifest,
} from "./manifests.ts";
import { clineSession, SOURCE_ID } from "./toSession.ts";

/** The variable that names Cline's folder, for Agent Lookout alone. */
export const CLINE_HOME_ENV = "AGENT_LOOKOUT_CLINE_HOME";

/** Cline's own variables for its folder, its data folder and its sessions folder. */
export const CLINE_OWN_HOME_ENV = "CLINE_DIR";
export const CLINE_OWN_DATA_ENV = "CLINE_DATA_DIR";
export const CLINE_OWN_SESSIONS_ENV = "CLINE_SESSION_DATA_DIR";

/** How long a sessions folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/**
 * How often every session's manifest is looked up, for one last written over a
 * day ago that was opened again. A new session's folder is found on the next
 * poll, and the sessions already shown are looked up on every poll.
 */
export const SWEEP_MS = 60_000;

/** The way this adapter reads, named for the poller. */
export const BASIS = "files";

const LABEL = "Cline";

/** Said whenever Cline is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "A Cline session shows as needing you while Cline waits for a tool's approval. A question Cline asks you shows as working.";

/** Said whenever Cline is watched, until Agent Lookout has been checked against it. */
export const UNCHECKED_NOTE =
  "This was built from Cline's source at cli-v3.0.74 and has not yet been checked on a computer running it, so a status can be wrong.";

/** Said when a manifest is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "A Cline newer than this Agent Lookout wrote a session in a format it does not read, so that session is not shown.";

/** Said when a manifest is over the most this reads. */
export const TOO_LARGE_NOTE =
  "A Cline session's manifest is over 1 MiB, the most Agent Lookout reads, so that session is not shown.";

/** Said when a session's status is unknown. */
export const UNKNOWN_NOTE =
  "A Cline session shows as unknown while its manifest gives a status Agent Lookout does not know, or no process to ask about.";

/**
 * What a Cline session can show, from the files this adapter reads. See
 * docs/adapters/cline.md for each. Built from Cline's source at cli-v3.0.74 and
 * not yet checked on a computer running it. The older VS Code extension keeps
 * its tasks in the editor's own storage, which this adapter does not read.
 *
 * - Working and idle are the manifest's `running` and `idle` while its process
 *   runs. Cline's hub holds a session on after the window that opened it closes,
 *   and stays running, so such a session stays idle, or working.
 * - Needs you while the manifest says `pending`, which Cline writes around a
 *   tool's approval and nowhere else at this tag. A question writes nothing, so
 *   it shows as working.
 * - Finished once the manifest says `completed` or `cancelled`, or its process
 *   has gone or was not the manifest's. On a Mac the last is by when `ps` says
 *   it started (`processCheck.ts`). Elsewhere a pid given to another program
 *   counts as the session's. A session resumed in a new process keeps the pid
 *   of the one before, so it shows as finished while it runs.
 * - Failed when the manifest says so: a turn that threw, a one-shot run that
 *   ended on an error, an open session closed after a failed turn, or a Cline
 *   that found the process dead. An open session whose turn ended on an error
 *   without throwing shows as idle until it closes.
 * - Its name is its folder's: Cline's title is by default the first line of its
 *   first prompt, so it is not kept.
 * - No Jump: the process can be the hub, which many sessions share.
 * - Quiet for is the newest modified time of the manifest and the messages
 *   file, which is looked up and never opened.
 * - No tokens: the manifest holds a session's running totals, and a reply's own
 *   counts are in the messages file, which is never opened.
 * - No Stop: Agent Lookout stops Claude Code sessions only so far.
 * - No Answer: Agent Lookout does not talk to Cline's hub or its runtime.
 */
export const CLINE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "From each session's manifest. Cline's hub holds a session on, so it stays idle after its window closes.",
  },
  "needs-you": {
    level: "partly",
    reason: "While Cline waits for a tool's approval. A question it asks you shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once Cline says so or its process goes. A session resumed in a new process shows as finished as it runs.",
  },
  failed: {
    level: "partly",
    reason:
      "When Cline writes it. An open session whose turn ended on an error shows as idle until it closes.",
  },
  names: {
    level: "partly",
    reason:
      "The folder's name. Cline's own title is by default the start of your first prompt, which is never kept.",
  },
  jump: {
    level: "no",
    reason:
      "The process a session names can be Cline's hub, shared by many sessions and in no terminal.",
  },
  "quiet-for": { level: "yes" },
  tokens: {
    level: "no",
    reason:
      "The manifest holds a session's running totals. A reply's own counts are in a file that is never opened.",
  },
  stop: {
    level: "no",
    reason: "Agent Lookout stops Claude Code sessions only so far.",
  },
  answer: {
    level: "no",
    reason:
      "Agent Lookout does not talk to Cline's hub or its runtime, so it cannot send an answer.",
  },
};

/** A setting's value, trimmed. Empty is none. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/**
 * The folder this adapter reads. `AGENT_LOOKOUT_CLINE_HOME` names Cline's
 * folder, for Agent Lookout alone. Otherwise it is worked out as Cline does
 * (`shared/src/storage/paths.ts:158-200`): `CLINE_SESSION_DATA_DIR`, else
 * `sessions` in `CLINE_DATA_DIR`, else `data/sessions` in `CLINE_DIR` or
 * `~/.cline`. The folder `cline --config` names is not followed: the setting is
 * how to name it.
 */
export function clineSessionsDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const own = setting(env, CLINE_HOME_ENV);
  if (own !== undefined) return path.resolve(own, "data", "sessions");
  const sessions = setting(env, CLINE_OWN_SESSIONS_ENV);
  if (sessions !== undefined) return path.resolve(sessions);
  const data = setting(env, CLINE_OWN_DATA_ENV);
  if (data !== undefined) return path.resolve(data, "sessions");
  return path.resolve(
    setting(env, CLINE_OWN_HOME_ENV) ?? path.join(homeDir, ".cline"),
    "data",
    "sessions",
  );
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface ClineAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** Whether a process runs, with signal 0, which tests a process and sends it nothing. */
  isAlive?: (pid: number) => boolean;
  /** The system's rules for folder names, and whether `ps` is asked. Defaults to this one. */
  platform?: NodeJS.Platform;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often every session's manifest is looked up. Defaults to a minute. */
  sweepMs?: number;
  /** Reads when processes started, on a Mac. Defaults to asking `ps`. */
  readProcessStarts?: ReadProcessStarts;
}

/** One manifest this poll read, with what its session is shown from. */
interface Found {
  manifest: Manifest;
  statusWrittenAt: number;
  /** The newest modified time of the manifest and the messages file. */
  writtenAt: number;
  /** Its process, when its manifest says it is open and names one that runs. */
  live: RecordProcess | null;
}

/** What tells one manifest's process from another's, for `ruledOut`. */
const processMark = ({ pid, startedAt }: RecordProcess) => `${pid} ${startedAt}`;

/**
 * What Sources says tells a session's process from another program given its
 * pid, and how often that is asked. Where `ps` is not asked, signal 0 is all
 * there is.
 */
function processCheckFacts(asksPs: boolean, pollIntervalMs: number): SourceFact[] {
  if (!asksPs) {
    return [{ label: "Process check", value: `signal 0 alone, ${every(pollIntervalMs)}` }];
  }
  return [
    { label: "Process check", value: "ps -o pid=,lstart= -p <pids>" },
    {
      label: "Process check run",
      value: `${every(START_CHECK_TTL_MS)} while a session's process runs, and sooner when another appears`,
    },
  ];
}

/**
 * Finds Cline sessions on this machine from the files Cline's runtime keeps,
 * with nothing installed, no setting changed and no Cline program run. Built
 * from Cline's source at cli-v3.0.74 and not yet checked on a computer running
 * it.
 *
 * Cline's CLI, its desktop app and the VS Code builds that run the same runtime
 * write one manifest for each session, `<sessions folder>/<id>/<id>.json`, and
 * this adapter reads those (`manifests.ts`). The older VS Code extension's
 * tasks, in the editor's own storage, are not read. Cline's database of
 * sessions, its hub and its messages files are never opened.
 *
 * Cline keeps every session it ever ran there, so a poll lists the folder, then
 * looks up only the sessions it shows and any new folder, with one `lstat` each.
 * Every other manifest is looked up once a minute, and a manifest last written
 * over a day ago is opened only for a session still shown. A manifest is opened
 * only when it changes.
 * So a session is first listed by its manifest's time alone, when that is within
 * 24 hours. Once listed, it stays for 24 hours after its manifest or, while that
 * says it is open, its messages file was last written, and for as long as it
 * works or waits and its process runs. An open session left idle for a day leaves
 * the list until its manifest is written.
 *
 * Whether a session's process runs is asked with signal 0, which sends nothing,
 * only for a session whose manifest says it is open. A crash leaves such a
 * manifest behind, and the session is then finished. On a Mac, `ps` is asked
 * too when the process started, and one that started more than a minute after
 * the session did was given a dead process's pid. Only on a Mac, because a
 * comparison acts only when it is sure: Linux's `ps` works a start out again
 * from the clock each time, a manifest holds no start token to read from
 * `/proc`, and Windows has no `ps`. A session's status is working, needs-you,
 * idle, finished, failed or unknown.
 *
 * Cline not being installed costs nothing: when the sessions folder is missing,
 * the adapter says so and looks again only once a minute. Someone who sets
 * `AGENT_LOOKOUT_CLINE_HOME` means that folder: if it holds no sessions, that
 * is an answer, not a missing Cline.
 */
export function createClineAdapter(options: ClineAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const isAlive = options.isAlive ?? isProcessAlive;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const asksPs = platform === "darwin";
  const processCheck = asksPs ? createRecordProcessCheck(options.readProcessStarts, now) : null;

  const named = setting(env, CLINE_HOME_ENV) !== undefined;
  const sessionsDir = clineSessionsDirFor(env, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);
  const manifests = createManifestReader(sessionsDir, io, platform);
  const processFacts = processCheckFacts(asksPs, pollIntervalMs);

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** When every manifest was last looked up. */
  let sweptAt: number | null = null;
  /** The sessions the last poll showed. */
  let shown = new Set<string>();
  /** The folders last found to hold a manifest written over a day ago, looked up only by a sweep. */
  let settled = new Set<string>();
  /**
   * Each process `ps` showed another program has, by `processMark`, kept while
   * that pid runs. A pid goes only to a program that starts later, so the answer
   * stands: a later check that cannot answer does not bring the session back.
   */
  let ruledOut = new Set<string>();

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    sessions: Session[] = [],
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: [
        { label: "Sessions folder", value: sessionsName },
        { label: "Read", value: read },
        ...processFacts,
      ],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis: BASIS } : { health, sessions: [] };
  }

  /** Cline is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `Cline was not found: there is no ${sessionsName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** A manifest's `lstat`, or null when no ordinary file is at its name. */
  async function lookUp(file: string): Promise<FileInfo | null> {
    try {
      const info = await io.lstat(file);
      return info.kind === "file" ? info : null;
    } catch {
      return null;
    }
  }

  /** Whether it is time to look up every manifest. A clock set back counts as time enough. */
  function sweepDue(checkedAt: number): boolean {
    if (sweptAt === null) return true;
    const since = checkedAt - sweptAt;
    return since < 0 || since >= sweepMs;
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Cline is believed missing for a while, so a machine without it
    // pays nothing on most polls.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    let names: string[];
    try {
      names = await io.readdir(sessionsDir);
    } catch (error) {
      if (!isMissing(error)) {
        return result(
          "error",
          `Cline sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      shown = new Set();
      settled = new Set();
      sweptAt = null;
      manifests.keepOnly(shown);
      if (named) {
        return result(
          "ok",
          `${CLINE_HOME_ENV} is set, and there is no ${sessionsName} folder, so no Cline sessions are listed. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`,
          "not found",
          checkedAt,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    const sweep = sweepDue(checkedAt);
    if (sweep) sweptAt = checkedAt;
    const stillSettled = new Set<string>();
    /** What this poll read, so a manifest it cannot use is not opened again until it changes. */
    const read = new Set<string>();
    const found: Found[] = [];
    let newer = false;
    let tooLarge = false;

    for (const id of names.filter(isSessionFolderName).sort()) {
      if (settled.has(id) && !sweep) {
        stillSettled.add(id);
        continue;
      }
      const info = await lookUp(manifestPath(sessionsDir, id));
      if (info === null) continue;
      // A manifest last written over a day ago is not opened, unless its session
      // is shown already: one that works or waits stays for as long as that lasts.
      if (!shown.has(id) && !isWithinRetention(Math.floor(info.mtimeMs), checkedAt)) {
        stillSettled.add(id);
        continue;
      }
      read.add(id);
      const answer = await manifests.read(id, info);
      if (answer.state === "newer") newer = true;
      if (answer.state === "too-large") tooLarge = true;
      if (answer.state !== "ok") continue;

      const { manifest } = answer;
      const open = isOpenClineStatus(manifest.status);
      const messages = open ? await lookUp(messagesPath(sessionsDir, id)) : null;
      const { pid, startedAt } = manifest;
      found.push({
        manifest,
        statusWrittenAt: answer.statusWrittenAt,
        writtenAt: Math.max(info.mtimeMs, messages?.mtimeMs ?? -Infinity),
        live: open && pid !== null && isAlive(pid) ? { pid, startedAt } : null,
      });
    }

    // On a Mac, a process that started more than a minute after its session did
    // was given the pid of a Cline that ended.
    const running = found.flatMap(({ live }) => live ?? []);
    const matches = await processCheck?.matches(running);
    ruledOut = new Set(
      running
        .filter((one) => matches?.get(one) === "different" || ruledOut.has(processMark(one)))
        .map(processMark),
    );

    const sessions: Session[] = [];
    const stillShown = new Set<string>();
    for (const { manifest, statusWrittenAt, writtenAt, live } of found) {
      const asked = isOpenClineStatus(manifest.status) && manifest.pid !== null;
      const session = clineSession({
        manifest,
        processRuns: asked ? live !== null && !ruledOut.has(processMark(live)) : null,
        statusWrittenAt,
        writtenAt,
        now: checkedAt,
      });
      const busy = session.status === "working" || session.status === "needs-you";
      if (busy || isWithinRetention(Math.floor(writtenAt), checkedAt)) {
        sessions.push(session);
        stillShown.add(manifest.sessionId);
      } else {
        stillSettled.add(manifest.sessionId);
      }
    }

    settled = stillSettled;
    shown = stillShown;
    manifests.keepOnly(read);

    let detail = `Sessions are read from the manifest Cline keeps for each one in ${sessionsName}. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;
    if (sessions.some((session) => session.status === "unknown")) detail += ` ${UNKNOWN_NOTE}`;
    if (newer) detail += ` ${NEWER_FORMAT_NOTE}`;
    if (tooLarge) detail += ` ${TOO_LARGE_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: CLINE_CAPABILITIES,
    lookingIn: `Looking for Cline sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Cline sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
