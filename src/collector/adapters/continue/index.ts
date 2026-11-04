import os from "node:os";
import path from "node:path";

import type {
  Session,
  SourceCapabilities,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import { createSessionFileFinder } from "./sessionFiles.ts";
import { createIndexReader, INDEX_FILE, MAX_INDEX_BYTES } from "./sessionIndex.ts";
import { continueSession, SOURCE_ID } from "./toSession.ts";

/** The variable that names Continue's folder, for Agent Lookout alone. */
export const CONTINUE_HOME_ENV = "AGENT_LOOKOUT_CONTINUE_HOME";

/** Continue's own variable for its folder. */
export const CONTINUE_OWN_HOME_ENV = "CONTINUE_GLOBAL_DIR";

/** How long a sessions folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** The way this adapter reads, named for the poller. */
export const BASIS = "files";

const LABEL = "Continue";

/** Said whenever Continue is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "Nothing Agent Lookout reads says whether a Continue session is working, waiting for you or over, and nothing ties a session to a process, so a session shows as unknown until a day after it was last written.";

/** Said whenever Continue is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Continue's source at v1.5.45 and not yet checked on a computer running Continue, so what it shows can be wrong.";

/**
 * What a Continue session can show, from the files this adapter reads. See
 * docs/adapters/continue.md for each. Built from Continue's source at v1.5.45 and
 * not yet checked on a computer running it.
 *
 * - No Working and idle: Continue writes nothing that says a session runs, and
 *   `ps` shows `cn` as `node`, as every other Node program that sets no title.
 * - No Needs you: `cn` writes a tool call as `generated` while it waits for
 *   approval, and a crash leaves it so, with nothing to tell the two apart. Every
 *   tool call is written that way first, too, so the file is not opened for it.
 * - No Finished: Continue writes no end to a session, and nothing says no `cn`
 *   runs.
 * - No Failed: a failed turn is written nowhere that says so.
 * - The name is the folder's. Continue's title can be a line of the first prompt,
 *   and no field says when it is not, so it is never kept.
 * - No Jump, Stop or Answer: the files name no process or terminal.
 * - No Quiet for: the page says how quiet a working session is, and a Continue
 *   session is never shown as working.
 * - No Tokens: a reply's counts are in the session's file, which is never opened.
 */
export const CONTINUE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "no",
    reason: "Continue writes nothing that says a session runs, and ps shows cn only as node.",
  },
  "needs-you": {
    level: "no",
    reason:
      "A tool call waiting for approval is written as one a crash left behind is, with nothing to tell them apart.",
  },
  finished: {
    level: "no",
    reason: "Continue writes no end to a session, and ps shows cn only as node.",
  },
  failed: { level: "no", reason: "Continue writes nothing that says a turn failed." },
  names: {
    level: "partly",
    reason: "The folder's name. Continue's own title can be a line of your first prompt.",
  },
  jump: { level: "no", reason: "Continue's files name no process or terminal." },
  "quiet-for": {
    level: "no",
    reason: "It is shown for a working session, and a Continue session never shows as working.",
  },
  tokens: {
    level: "no",
    reason: "A reply's counts are in the session's file, which is never opened.",
  },
  stop: {
    level: "no",
    reason: "Continue's files name no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Continue, so it cannot send an answer.",
  },
};

/**
 * Continue's folder. `AGENT_LOOKOUT_CONTINUE_HOME` names it, for Agent Lookout
 * alone. Otherwise it is worked out as Continue does (`core/util/paths.ts`):
 * `CONTINUE_GLOBAL_DIR`, else `~/.continue`, on every system. A relative
 * `CONTINUE_GLOBAL_DIR` means a folder relative to where Continue was started,
 * which cannot be known here, so it is gone past.
 */
export function continueHomeFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const own = env[CONTINUE_HOME_ENV]?.trim();
  if (own) return path.resolve(own);
  const theirs = env[CONTINUE_OWN_HOME_ENV]?.trim();
  if (theirs && path.isAbsolute(theirs)) return path.resolve(theirs);
  return path.join(homeDir, ".continue");
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface ContinueAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** The system's rules for folders. Defaults to this one. */
  platform?: NodeJS.Platform;
  /**
   * How often the poller calls `poll()`, which is how often the files are
   * looked at. The adapter keeps no timer of its own: this is only stated in
   * `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often every session's file is looked up. Defaults to a minute. */
  sweepMs?: number;
}

/**
 * Finds Continue's sessions on this machine from the list Continue keeps, with
 * nothing installed, no setting changed and no program run. Built from Continue's
 * source at v1.5.45, and not yet checked on a computer running it.
 *
 * `cn` and Continue's editor extensions share `~/.continue/sessions`: one file for
 * each session, and `sessions.json`, the list of them. A poll looks at the sessions
 * folder and the list, with one `lstat` each, and opens the list only when it
 * changes (`sessionIndex.ts`). It looks up the file of each session written in the
 * last day, and every other session's once a minute (`sessionFiles.ts`). A session's
 * own file, which holds the conversation, is never opened.
 *
 * Each session whose file was written in the last 24 hours is listed, as unknown.
 * Nothing Continue writes says whether a session runs, nothing ties a session to a
 * process, and `cn` shows in `ps` as `node`, so `ps` is not run. A session never
 * shows as working, as needing you or as finished.
 *
 * Continue not being installed costs nothing: when the sessions folder is missing,
 * the adapter says so and looks again only once a minute. Someone who sets
 * `AGENT_LOOKOUT_CONTINUE_HOME` means that folder: if it holds no sessions, that is
 * an answer, not a missing Continue.
 */
export function createContinueAdapter(options: ContinueAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;

  const named = Boolean(env[CONTINUE_HOME_ENV]?.trim());
  const sessionsDir = path.join(continueHomeFor(env, homeDir), "sessions");
  const sessionsName = tildify(sessionsDir, homeDir);
  const indexFile = path.join(sessionsDir, INDEX_FILE);
  const indexName = tildify(indexFile, homeDir);
  const files = createSessionFileFinder({ sessionsDir, io, sweepMs: options.sweepMs });
  const index = createIndexReader(indexFile, io, platform);

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;

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
      ],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis: BASIS } : { health, sessions: [] };
  }

  /** Continue is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `Continue was not found: there is no ${sessionsName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** A failure, said in a sentence that names where it looked. */
  function failed(detail: string, checkedAt: number): AdapterResult {
    return result("error", detail, "cannot be read", checkedAt);
  }

  const alwaysNotes = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Continue is believed missing for a while, so a machine without it
    // pays nothing on most polls. A clock set back counts as time enough.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    let folder: FileInfo;
    try {
      folder = await io.lstat(sessionsDir);
    } catch (error) {
      if (!isMissing(error)) {
        return failed(
          `Continue sessions could not be read: the folder ${sessionsName} could not be looked at.`,
          checkedAt,
        );
      }
      files.forget();
      if (named) {
        return result(
          "ok",
          `${CONTINUE_HOME_ENV} is set, and there is no ${sessionsName} folder, so no Continue sessions are listed. ${alwaysNotes}`,
          "not found",
          checkedAt,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    // Nothing is opened through a link at the folder's name.
    if (folder.kind !== "directory") {
      return failed(
        `Continue sessions could not be read: ${sessionsName} is not a folder, and a link is not followed.`,
        checkedAt,
      );
    }

    const listed = await index.read();
    if (listed.state === "unreadable") {
      return failed(
        `Continue sessions could not be read: ${indexName} is not an ordinary file, or could not be opened.`,
        checkedAt,
      );
    }
    if (listed.state === "broken") {
      return failed(
        `Continue sessions could not be read: ${indexName} is not a list Agent Lookout can read.`,
        checkedAt,
      );
    }
    if (listed.state === "too-large") {
      const most = MAX_INDEX_BYTES / (1024 * 1024);
      return failed(
        `Continue sessions could not be read: ${indexName} is over ${most} MiB, the most Agent Lookout reads.`,
        checkedAt,
      );
    }

    const read = every(pollIntervalMs);
    if (listed.state === "missing") {
      files.forget();
      return result(
        "ok",
        `There is no list of sessions in ${sessionsName} yet, so no Continue sessions are listed. ${alwaysNotes}`,
        read,
        checkedAt,
      );
    }

    const recent = await files.recent(listed.sessions, checkedAt);
    const sessions = recent.map(({ session }) => continueSession(session, checkedAt));
    return result(
      "ok",
      `Sessions are read from the list Continue keeps in ${sessionsName}. ${alwaysNotes}`,
      read,
      checkedAt,
      sessions,
    );
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: CONTINUE_CAPABILITIES,
    lookingIn: `Looking for Continue sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Continue sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
