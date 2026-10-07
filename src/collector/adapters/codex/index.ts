import os from "node:os";
import path from "node:path";

import { codexLiveness, isCodexSessionSource } from "../../../core/mapping/codexMapping.ts";
import { FINISHED_RETENTION_MS, isWithinRetention } from "../../../core/sessions/retention.ts";
import type {
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { plausibleTime } from "../../../core/time.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import { createRolloutReader, type RolloutState } from "./rolloutFile.ts";
import { createRolloutFinder, type RolloutRef } from "./rollouts.ts";
import { createSessionIndexReader, SESSION_INDEX_FILE } from "./sessionIndex.ts";
import { codexSession, lastActivity, SOURCE_ID } from "./toSession.ts";
import { readWriterLocks, WRITER_LOCK_DIR } from "./writerLocks.ts";

/** The variable that replaces the Codex folder, for Agent Lookout alone. */
export const CODEX_HOME_ENV = "AGENT_LOOKOUT_CODEX_HOME";

/** Codex's own variable for its folder, documented by Codex. Codex and this adapter then read the same place. */
export const CODEX_OWN_HOME_ENV = "CODEX_HOME";

/** How long a Codex folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** The usual way this adapter reads, named for the poller. */
export const BASIS = "files";

/**
 * The way it reads while its folder of locks is missing or cannot be listed.
 * Then no session can be shown as finished, so a session that had finished
 * shows as idle. Named apart, so that one poll without the locks is not
 * compared with one that had them, and every finished session does not seem
 * to start again and then finish.
 */
export const BASIS_WITHOUT_LOCKS = "files-without-locks";

const LABEL = "Codex";

/** Said whenever Codex is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "Codex's session files do not record when it is waiting for your approval, so a Codex session that is waiting for you shows as working.";

/**
 * Said when a session made by a Codex older than 0.155 is listed beside ones
 * made by a newer Codex, which do leave locks: two Codex installs, such as the
 * terminal app and an older one inside an editor, writing to the same folder.
 */
export const OLDER_CODEX_NOTE =
  "Some sessions were started by a Codex older than 0.155, which does not record which sessions are open, so those are never shown as finished.";

/**
 * What a Codex session can show, from the files this adapter reads. See
 * docs/adapters/codex.md for each.
 *
 * - Working and idle are the last turn line (`codexMapping.ts`).
 * - Needs you never: the approval events are never written to the files.
 * - Finished is a session no Codex program has open, which only a Codex of
 *   0.155 or later records, in its folder of locks.
 * - Failed never: Codex writes no error to the files, and a stopped turn
 *   reads as idle.
 * - Its name comes from the names file, which the desktop app does not write.
 * - No Jump: the files name no process, and the desktop app's link is
 *   undocumented (`toSession.ts`).
 * - Quiet for is the file's own modified time, moved on by every line.
 * - No Stop: with no process named, there is nothing to confirm and stop.
 * - No Answer: Codex records no approval waits to answer.
 */
export const CODEX_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": {
    level: "no",
    reason: "Codex does not record approval waits, so a session waiting for you shows as working.",
  },
  finished: {
    level: "partly",
    reason: "From Codex 0.155 on, once no Codex program has the session open.",
  },
  failed: { level: "no", reason: "Codex does not record errors in its files." },
  names: {
    level: "partly",
    reason:
      "The desktop app does not keep its titles in the names file Agent Lookout reads, so its sessions take their folder's name.",
  },
  jump: {
    level: "no",
    reason: "Codex's files name no process to find, and Codex documents no link to a session.",
  },
  "quiet-for": { level: "yes" },
  stop: {
    level: "no",
    reason: "Codex's files name no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason:
      "Codex records no approval waits, so there is nothing to answer from here, by hand or by a permission rule.",
  },
};

/** Everything the adapter touches outside itself. Tests replace these. */
export interface CodexAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   * Defaults to the poller's interval.
   */
  pollIntervalMs?: number;
  /** How long a missing Codex folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often, at most, every day folder is listed again. Defaults to 30 seconds. */
  indexRefreshMs?: number;
  /** How soon a newly opened session may cause that listing. Defaults to 5 seconds. */
  indexPromptRefreshMs?: number;
}

/** Where the Codex folder was named. */
type HomeFrom = "agent-lookout" | "codex" | "default";

/**
 * Finds Codex sessions on this machine from the files Codex keeps, with
 * nothing installed, no setting changed and no program run.
 *
 * Codex documents no listing a passive reader can use: its app-server's
 * `thread/list` starts Codex's own start-up work, which writes under the Codex
 * folder, and reports threads other processes own as not loaded. So the
 * adapter reads three things, all undocumented, all read-only:
 *
 * - The session files under `<codex home>/sessions`, for each session's folder,
 *   app and turns, and, from the modified time the adapter already looks at,
 *   when Codex last wrote to each. See `rolloutFile.ts`.
 * - The lock folder `<codex home>/thread-writer-locks`, listed and never
 *   opened, for which sessions a Codex process has open. See `writerLocks.ts`.
 * - `<codex home>/session_index.jsonl`, for the names people give sessions.
 *
 * A session is listed while Codex has it open, and for 24 hours after its last
 * line. Its status is working, idle or finished, never "needs-you": Codex does
 * not write approval waits to these files. A session the Codex desktop app
 * imported from another agent is left out until Codex runs a turn in it.
 *
 * Codex not being installed costs nothing: when its folder is missing, the
 * adapter says so and looks again only once a minute, with a single `stat`.
 *
 * The folder is `AGENT_LOOKOUT_CODEX_HOME` if set, then Codex's own
 * `CODEX_HOME`, then `~/.codex`. Someone who sets `AGENT_LOOKOUT_CODEX_HOME`
 * means that folder: if it holds no sessions, that is an answer, not a
 * missing Codex.
 */
export function createCodexAdapter(options: CodexAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;

  const ownOverride = env[CODEX_HOME_ENV]?.trim() || undefined;
  const codexOverride = env[CODEX_OWN_HOME_ENV]?.trim() || undefined;
  const homeFrom: HomeFrom = ownOverride ? "agent-lookout" : codexOverride ? "codex" : "default";
  const codexHome = path.resolve(ownOverride ?? codexOverride ?? path.join(homeDir, ".codex"));
  const sessionsDir = path.join(codexHome, "sessions");
  const locksDir = path.join(codexHome, WRITER_LOCK_DIR);
  const indexFile = path.join(codexHome, SESSION_INDEX_FILE);

  const homeName = tildify(codexHome, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);
  const locksName = tildify(locksDir, homeDir);
  const indexName = tildify(indexFile, homeDir);

  const finder = createRolloutFinder({
    sessionsDir,
    io,
    refreshMs: options.indexRefreshMs,
    promptRefreshMs: options.indexPromptRefreshMs,
  });
  const reader = createRolloutReader(io);
  const sessionIndex = createSessionIndexReader(indexFile, io);

  /** When the Codex folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** True once the Codex folder has been seen, until the sessions folder goes missing. */
  let homeSeen = false;
  /** Session files found through a lock in an older day folder, kept while they matter. By path. */
  const tracked = new Map<string, RolloutRef>();

  function watching(read: string): SourceFact[] {
    return [
      { label: "Sessions folder", value: sessionsName },
      { label: "Read", value: read },
      { label: "Open-sessions folder", value: locksName },
      { label: "Names file", value: indexName },
    ];
  }

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: watching(read),
      checkedAt,
    };
    return state === "ok" ? { health, sessions: [], basis: BASIS } : { health, sessions: [] };
  }

  /** Codex is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    const where =
      homeFrom === "codex"
        ? `${CODEX_OWN_HOME_ENV} is set to ${homeName}, and there is no folder there`
        : `there is no ${homeName} folder`;
    return result(
      "unavailable",
      `Codex was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** Whether the Codex folder is there. Only a folder that is missing, or is not a folder, counts as not there. */
  async function homeIsThere(): Promise<boolean> {
    try {
      return (await io.stat(codexHome)).kind === "directory";
    } catch (error) {
      return !isMissing(error);
    }
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Codex is believed missing for a while, so a machine without it
    // pays nothing on most polls. A clock set back counts as time enough.
    if (homeFrom !== "agent-lookout") {
      if (absentAt !== null) {
        const since = checkedAt - absentAt;
        if (since >= 0 && since < recheckMs) return notFound(checkedAt);
      }
      if (!homeSeen) {
        if (!(await homeIsThere())) {
          absentAt = checkedAt;
          return notFound(checkedAt);
        }
        absentAt = null;
        homeSeen = true;
      }
    }

    try {
      await io.readdir(sessionsDir);
    } catch (error) {
      if (!isMissing(error)) {
        return result(
          "error",
          `Codex sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      if (homeFrom === "agent-lookout") {
        return result(
          "ok",
          `${CODEX_HOME_ENV} is set to ${homeName}, which has no sessions folder, so no Codex sessions are listed. ${NEEDS_YOU_NOTE}`,
          "not found",
          checkedAt,
        );
      }
      // Codex's own folder may have gone with its sessions folder.
      homeSeen = false;
      if (!(await homeIsThere())) {
        absentAt = checkedAt;
        return notFound(checkedAt);
      }
      homeSeen = true;
      return result(
        "ok",
        `Codex has not saved any sessions in ${sessionsName} yet. ${NEEDS_YOU_NOTE}`,
        "not found",
        checkedAt,
      );
    }

    const locks = await readWriterLocks(locksDir, io);
    const locked = (threadId: string) => locks.supported && locks.open.has(threadId);

    // The files to look at: today's and yesterday's, and those of open
    // sessions that sit in older folders, as a resumed session's does.
    const candidates = new Map<string, RolloutRef>();
    for (const ref of await finder.recent(checkedAt)) candidates.set(ref.path, ref);
    for (const ref of tracked.values()) candidates.set(ref.path, ref);
    if (locks.supported) {
      const found = new Set([...candidates.values()].map((ref) => ref.threadId));
      const elsewhere = [...locks.open].filter((threadId) => !found.has(threadId)).sort();
      for (const ref of await finder.locate(elsewhere, checkedAt)) {
        tracked.set(ref.path, ref);
        candidates.set(ref.path, ref);
      }
    }

    const names = await sessionIndex.names();
    const cutoff = checkedAt - FINISHED_RETENTION_MS;
    /** The files read this poll, whose cache is worth keeping. */
    const read = new Set<string>();
    /** The file to show for each thread, with its modified time: a reverted session has more than one. */
    const chosen = new Map<string, { state: RolloutState; at: number | null; writtenAt: number }>();
    /** When each session's subagents last wrote to their own files, by the session's thread. */
    const subagentWrites = new Map<string, number>();

    for (const ref of [...candidates.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const open = locked(ref.threadId);
      let info: FileInfo;
      try {
        info = await io.lstat(ref.path);
      } catch {
        tracked.delete(ref.path);
        continue;
      }
      // A link, a pipe or a device is not a session file, whatever it is called.
      // A file not written for a day, of a session no Codex has open, is old
      // news: every line Codex adds moves its modified time on.
      if (info.kind !== "file" || (!open && info.mtimeMs < cutoff)) {
        tracked.delete(ref.path);
        continue;
      }

      let state: RolloutState;
      try {
        state = await reader.read(ref.path, info);
      } catch {
        // Unreadable this time. What was read of it before is kept for the next poll.
        read.add(ref.path);
        continue;
      }
      read.add(ref.path);

      if (state.meta === null) continue;
      if (!isCodexSessionSource(state.meta.source, state.meta)) {
        // A subagent writes to its own file while the session that started it
        // waits on it and writes nothing, so its writes count as that session's.
        // A time that could not be right is left out, so that it cannot hide the
        // session's own. A subagent's own subagents are not counted.
        const parent = state.meta.parentThreadId?.toLowerCase();
        const writtenAt = plausibleTime(Math.floor(info.mtimeMs), checkedAt);
        if (parent !== undefined && writtenAt !== null) {
          subagentWrites.set(parent, Math.max(subagentWrites.get(parent) ?? writtenAt, writtenAt));
        }
        continue;
      }
      // Another agent's past session, copied in by the Codex desktop app: it did
      // not run in Codex, and its lines carry the time of the import. It is
      // listed once Codex runs a turn in it.
      if (state.lastTurnImported) continue;
      const at = lastActivity(state, checkedAt);
      if (!open && (at === null || !isWithinRetention(at, checkedAt))) {
        tracked.delete(ref.path);
        continue;
      }
      const kept = chosen.get(ref.threadId);
      if (!kept || (at ?? -Infinity) > (kept.at ?? -Infinity)) {
        chosen.set(ref.threadId, { state, at, writtenAt: info.mtimeMs });
      }
    }
    reader.keepOnly(read);

    /** Whether a session made by a Codex that keeps no locks is listed beside ones that do. */
    let olderCodex = false;
    const sessions = [...chosen.entries()].map(([threadId, { state, writtenAt }]) => {
      const live = codexLiveness({
        lockFolder: locks.supported,
        locked: locked(threadId),
        cliVersion: state.meta?.cliVersion,
      });
      if (locks.supported && live === "unknown") olderCodex = true;
      return codexSession({
        threadId,
        state,
        name: names.get(threadId),
        live,
        writtenAt: Math.max(writtenAt, subagentWrites.get(threadId) ?? -Infinity),
        now: checkedAt,
      });
    });

    let detail = `Sessions are read from the files Codex saves in ${sessionsName}. ${NEEDS_YOU_NOTE}`;
    if (!locks.supported) {
      const why = locks.missing
        ? `There is no list of open sessions at ${locksName}, which Codex keeps from version 0.155 on`
        : `The list of open sessions at ${locksName} could not be read`;
      detail += ` ${why}, so a session that has ended cannot be told from one that is idle, and none is shown as finished.`;
    } else if (olderCodex) {
      detail += ` ${OLDER_CODEX_NOTE}`;
    }
    const answer = result("ok", detail, every(pollIntervalMs), checkedAt);
    return { ...answer, sessions, basis: locks.supported ? BASIS : BASIS_WITHOUT_LOCKS };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: CODEX_CAPABILITIES,
    lookingIn: `Looking for Codex sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Codex sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
