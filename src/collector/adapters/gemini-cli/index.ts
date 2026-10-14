import os from "node:os";
import path from "node:path";

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
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import { createChatFileReader, type ChatFileState } from "./chatFile.ts";
import { createChatLister } from "./chats.ts";
import { createProjectLister } from "./projects.ts";
import { geminiCliSession, lastActivity, SOURCE_ID } from "./toSession.ts";

/** The variable that names Gemini CLI's folder, the one that holds `tmp/`, for Agent Lookout alone. */
export const GEMINI_CLI_HOME_ENV = "AGENT_LOOKOUT_GEMINI_CLI_HOME";

/**
 * Gemini CLI's own variable, documented by Gemini CLI. It names a home folder,
 * not Gemini CLI's folder: Gemini CLI then keeps its files in `.gemini` inside it.
 */
export const GEMINI_CLI_OWN_HOME_ENV = "GEMINI_CLI_HOME";

/** Gemini CLI's folder in a home folder. */
export const DEFAULT_DIR = ".gemini";

/** The folder in Gemini CLI's folder that holds every project's sessions. */
export const TMP_DIR = "tmp";

/** How long a Gemini CLI folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** The one way this adapter reads, named for the poller. */
export const BASIS = "files";

const LABEL = "Gemini CLI";

/** Said whenever Gemini CLI is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "Gemini CLI does not write approval waits or running tools to its files, so a session waiting for you shows as working, or as idle after a reply with text.";

/** Said whenever Gemini CLI is watched: the files are all there is to read. */
export const FILES_ONLY_NOTE =
  "Gemini CLI documents no way for another program to list every project's sessions, so Agent Lookout reads its files alone.";

/** Said until this adapter is checked against a machine that runs Gemini CLI. */
export const UNCHECKED_NOTE =
  "This was written from Gemini CLI 0.64.0's source and not yet checked against a real session, so a status can be wrong.";

/** Said when a project holds session files changed in the last day in the format this adapter does not read. */
export const OLDER_FORMAT_NOTE =
  "Some sessions changed in the last day are saved in the format of Gemini CLI before 0.39, which Agent Lookout does not read.";

/** Said when a session listed is unknown. */
export const UNKNOWN_NOTE =
  "Agent Lookout cannot tell how some Gemini CLI sessions stand from their last lines, so they show as unknown.";

/**
 * What a Gemini CLI session can show, from the files this adapter reads. See
 * docs/adapters/gemini-cli.md for each.
 *
 * - Working and idle partly: Gemini CLI writes a tool call only once it ends,
 *   so a reply with text whose tool still waits or runs reads as a final answer.
 * - Needs you never: approval waits are never written to its files.
 * - Finished never: it writes no lock and no mark when a session ends, so a
 *   closed session keeps its last status, working when it closed mid-turn.
 * - Failed never, for now: its errors are not read yet.
 * - Its name is the title Gemini CLI saves at a later start in the same folder.
 * - No Jump: the files name no process or terminal.
 * - Quiet for is the file's own modified time, moved on by every line.
 * - No tokens yet.
 * - No Stop and no Answer: there is no process to confirm, and no wait to answer.
 */
export const GEMINI_CLI_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Gemini CLI writes a tool call only once it ends, so a reply with text whose tool still waits or runs shows as idle.",
  },
  "needs-you": {
    level: "no",
    reason:
      "Gemini CLI does not write approval waits to its files, so a session waiting for you shows as working or idle.",
  },
  finished: {
    level: "no",
    reason:
      "Gemini CLI writes no end mark, so a closed session keeps its last status, idle or working, until a day after its last update.",
  },
  failed: {
    level: "no",
    reason:
      "Agent Lookout does not read Gemini CLI's errors yet, so a session whose request failed shows as idle.",
  },
  names: {
    level: "partly",
    reason:
      "The title Gemini CLI saves once a later start in the same folder sums the session up. Until then, the folder's name.",
  },
  jump: {
    level: "no",
    reason:
      "Gemini CLI's files name no process or terminal, and it documents no link that opens a session.",
  },
  "quiet-for": { level: "yes" },
  tokens: { level: "no", reason: "Agent Lookout does not read Gemini CLI's token counts yet." },
  stop: {
    level: "no",
    reason: "Gemini CLI's files name no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason:
      "Gemini CLI records no approval waits, so there is nothing to answer from here, by hand or by a permission rule.",
  },
};

/** Where Gemini CLI's folder was named. */
type HomeFrom = "agent-lookout" | "gemini-cli" | "default";

/**
 * The folder this adapter reads, the one that holds `tmp/`: the one
 * `AGENT_LOOKOUT_GEMINI_CLI_HOME` names, otherwise `.gemini` in the home folder
 * Gemini CLI's own `GEMINI_CLI_HOME` names, otherwise `~/.gemini`.
 */
export function geminiCliFolder(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
): { dir: string; from: HomeFrom } {
  const own = env[GEMINI_CLI_HOME_ENV]?.trim() || undefined;
  if (own) return { dir: path.resolve(own), from: "agent-lookout" };
  const geminiHome = env[GEMINI_CLI_OWN_HOME_ENV]?.trim() || undefined;
  if (geminiHome) return { dir: path.resolve(geminiHome, DEFAULT_DIR), from: "gemini-cli" };
  return { dir: path.resolve(homeDir, DEFAULT_DIR), from: "default" };
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface GeminiCliAdapterOptions {
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
  /** How long a missing Gemini CLI folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often, at most, `tmp/` and each folder of session files are listed again. Defaults to 30 seconds. */
  listRefreshMs?: number;
}

/**
 * Finds Gemini CLI sessions on this machine from the files Gemini CLI keeps,
 * with nothing installed, no setting changed and no program run.
 *
 * Gemini CLI documents no listing another program can use: `--list-sessions`
 * lists only one project's sessions, and starting it writes under Gemini CLI's
 * folder. So the adapter reads, all read-only:
 *
 * - `tmp/`, listed, for each project's folder, and in each the one line of
 *   `.project_root`, for the folder the project is for (`projects.ts`).
 * - Each project's `chats/`, listed, and the session files in it written to in
 *   the last day (`chats.ts`, `chatFile.ts`).
 *
 * A session is listed for 24 hours after its last update. Its status is
 * working, idle or unknown, never "needs-you", "finished" or "failed": Gemini
 * CLI writes nothing while a tool waits for approval or runs, and nothing when
 * a session ends. A subagent's own file is never listed. Two projects can each
 * hold a session of one id, which `--session-id` allows, so a session's id
 * names its project's folder too. Two files of one id in one project are listed
 * once, from the one active last, as Gemini CLI's own list shows them.
 *
 * Gemini CLI not being installed costs nothing: when `tmp/` is missing, the
 * adapter says so and looks again only once a minute, with a single `stat`.
 * Someone who sets `AGENT_LOOKOUT_GEMINI_CLI_HOME` means that folder: if it
 * holds no sessions, that is an answer, not a missing Gemini CLI.
 *
 * Built from Gemini CLI's source at v0.64.0, and not yet checked against a
 * machine running it.
 */
export function createGeminiCliAdapter(options: GeminiCliAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;

  const { dir: geminiDir, from: homeFrom } = geminiCliFolder(env, homeDir);
  const tmpDir = path.join(geminiDir, TMP_DIR);
  const homeName = tildify(geminiDir, homeDir);
  const tmpName = tildify(tmpDir, homeDir);

  const projects = createProjectLister({ tmpDir, io, refreshMs: options.listRefreshMs });
  const chats = createChatLister({ io, refreshMs: options.listRefreshMs });
  const reader = createChatFileReader(io);

  /** When `tmp/` was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;

  const alwaysNotes = `${NEEDS_YOU_NOTE} ${FILES_ONLY_NOTE} ${UNCHECKED_NOTE}`;

  function watching(read: string): SourceFact[] {
    return [
      { label: "Sessions folder", value: tmpName },
      { label: "Read", value: read },
      { label: "Files read", value: "chats/session-*.jsonl and .project_root in each project" },
      { label: "Programs run", value: "None" },
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

  /** Gemini CLI is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    const where =
      homeFrom === "gemini-cli"
        ? `${GEMINI_CLI_OWN_HOME_ENV} is set, and there is no ${tmpName} folder`
        : `there is no ${tmpName} folder`;
    return result(
      "unavailable",
      `Gemini CLI was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Gemini CLI is believed missing for a while, so a machine
    // without it pays nothing on most polls. A clock set back counts as time enough.
    if (homeFrom !== "agent-lookout" && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    let tmpInfo: FileInfo | null;
    try {
      // `tmp/` may be a link, as Gemini CLI's folder may be, so it is followed here.
      tmpInfo = await io.stat(tmpDir);
    } catch (error) {
      if (!isMissing(error)) {
        return result(
          "error",
          `Gemini CLI sessions could not be read: the folder ${tmpName} could not be looked at.`,
          "cannot be read",
          checkedAt,
        );
      }
      tmpInfo = null;
    }
    // Only a folder counts: `~/.gemini` alone does not, as Antigravity keeps its own files there.
    if (tmpInfo?.kind !== "directory") {
      if (homeFrom === "agent-lookout") {
        return result(
          "ok",
          `${GEMINI_CLI_HOME_ENV} is set to ${homeName}, which has no ${TMP_DIR} folder, so no Gemini CLI sessions are listed. ${alwaysNotes}`,
          "not found",
          checkedAt,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    let listing;
    try {
      listing = await chats.recent(await projects.list(tmpInfo, checkedAt), checkedAt);
    } catch {
      return result(
        "error",
        `Gemini CLI sessions could not be read: the folder ${tmpName} could not be listed.`,
        "cannot be read",
        checkedAt,
      );
    }

    /** The files read this poll, whose cache is worth keeping. */
    const read = new Set<string>();
    /** The file to show for each session, by project and id: a session saved twice has more than one. */
    const chosen = new Map<
      string,
      { state: ChatFileState; slug: string; cwd: string | null; at: number; writtenAt: number }
    >();
    for (const ref of [...listing.refs].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      let state: ChatFileState;
      try {
        state = await reader.read(ref.path, ref.info);
      } catch {
        // Unreadable this time. What was read of it before is kept for the next poll.
        read.add(ref.path);
        continue;
      }
      read.add(ref.path);
      const header = state.header;
      // Not a session's file, or a subagent's, which belongs to a session already listed.
      if (header === null || header.kind === "subagent") continue;
      const at = lastActivity(state, checkedAt);
      // With no way to tell an open session from a closed one, each is kept
      // for a day after its last update, and no longer.
      if (at === null || !isWithinRetention(at, checkedAt)) continue;
      // Gemini CLI tells sessions apart by id within one project's folder alone.
      const key = `${ref.project.slug}/${header.sessionId}`;
      const kept = chosen.get(key);
      if (!kept || at > kept.at) {
        chosen.set(key, {
          state,
          slug: ref.project.slug,
          cwd: ref.project.cwd,
          at,
          writtenAt: ref.info.mtimeMs,
        });
      }
    }
    reader.keepOnly(read);

    const sessions: Session[] = [];
    for (const { state, slug, cwd, writtenAt } of chosen.values()) {
      const session = geminiCliSession({ state, slug, cwd, writtenAt, now: checkedAt });
      if (session) sessions.push(session);
    }

    let detail = `Sessions are read from the files Gemini CLI saves in ${tmpName}. ${alwaysNotes}`;
    if (listing.older > 0) detail += ` ${OLDER_FORMAT_NOTE}`;
    if (sessions.some((session) => session.status === "unknown")) detail += ` ${UNKNOWN_NOTE}`;
    const answer = result("ok", detail, every(pollIntervalMs), checkedAt);
    return { ...answer, sessions };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: GEMINI_CLI_CAPABILITIES,
    lookingIn: `Looking for Gemini CLI sessions in ${tmpName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Gemini CLI sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
