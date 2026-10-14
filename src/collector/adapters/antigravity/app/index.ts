import os from "node:os";
import path from "node:path";

import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../../core/sessions/session.ts";
import { tildify } from "../../../files/paths.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../../poller.ts";
import type { Adapter, AdapterResult } from "../../adapter.ts";
import { every } from "../../words.ts";
import { createTitleReader } from "../shared/annotations.ts";
import {
  BRAIN_DIR,
  createConversationFinder,
  writtenRecently,
  type ConversationFiles,
} from "../shared/conversations.ts";
import { antigravitySession, APP_PROFILE } from "../shared/toSession.ts";
import { createTranscriptReader, type TranscriptState } from "../shared/transcriptFile.ts";
import {
  createHubProcessReader,
  HUB_TABLE_ARGS,
  hubLiveness,
  type HubAnswer,
  type HubProcessReader,
} from "./hubProcess.ts";
import {
  createSummariesReader,
  SUMMARIES_FILE,
  type SummariesReader,
  type SummariesState,
} from "./summaries.ts";
import { createWaitReader, type Wait, type WaitReader } from "./waits.ts";

/** The variable that replaces Antigravity 2.0's folder, for Agent Lookout alone. */
export const ANTIGRAVITY_APP_HOME_ENV = "AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME";

/** Where Antigravity 2.0 keeps its files, under the home folder. */
export const DEFAULT_APP_HOME = [".gemini", "antigravity"] as const;

/** The folder this adapter reads: the one `AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME` names, otherwise `~/.gemini/antigravity`. */
export function appHomeFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = env[ANTIGRAVITY_APP_HOME_ENV]?.trim() || undefined;
  return path.resolve(override ?? path.join(homeDir, ...DEFAULT_APP_HOME));
}

/** How long a folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked whether the app runs, while there are chats to show. */
export const PROCESS_CHECK_MS = 10_000;

/** How soon `ps` is asked again when a chat is written after it said the app was closed. */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/**
 * How recently a chat's files must have been written for one whose last step
 * reads as idle to show as working. Antigravity 2.0 writes a step to the
 * transcript only once it is done. It was seen to write a step that waits for
 * approval to its database before the transcript (`waits.ts`); whether it
 * writes the database while other steps run has not been seen yet. If it also
 * writes it later, as agy has been seen to half a minute after the transcript
 * (`../shared/conversations.ts`), an idle chat shows as working for these 10
 * seconds then.
 */
export const WRITING_MS = 10_000;

/** The usual way this adapter reads, named for the poller. */
export const BASIS = "files";

/**
 * The way it reads while `ps` cannot say whether the app runs: on Linux and
 * Windows, or when `ps` fails. No chat is shown as finished then, so the poll
 * is named apart, as the CLI's is.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

/**
 * The way it reads while `ps` says the app is closed, when every chat is
 * finished. Closing the app finishes every chat at once, and opening it again
 * shows them all as open, so such a poll is named apart and compared only
 * with the last time the app was closed. Then closing the app does not seem
 * to finish each chat of the last day, however often it is opened and closed.
 */
export const BASIS_APP_CLOSED = "files-app-closed";

const SOURCE_ID = APP_PROFILE.sourceId;
const LABEL = APP_PROFILE.label;

/** Said whenever Antigravity is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "A chat that waits for you to approve a step shows as needing you, but not what it asks: answer it in Antigravity.";

/** Said whenever Antigravity is watched, until the adapter has been checked against more of it. */
export const UNCHECKED_NOTE =
  "This was built from the layout of Antigravity 2.0's files on one Mac, and not yet checked against a chat that fails, so a status can be wrong.";

/** Said instead on Windows, where nothing is read for it. */
export const WINDOWS_NEEDS_YOU_NOTE =
  "On Windows a chat that waits for you to approve a step shows as working or idle: Agent Lookout reads whether a chat waits only on macOS and Linux.";

/** Said when a chat's last step is one this adapter does not know, or none could be read. */
export const UNKNOWN_STEP_NOTE =
  "Some chats end with a step Agent Lookout does not know, perhaps from a newer Antigravity, so they show as unknown.";

/**
 * What an Antigravity 2.0 chat can show, from the files this adapter reads,
 * `ps` and `sqlite3`. See docs/adapters/antigravity.md for each.
 *
 * - Working and idle are the transcript's last step, as for the CLI
 *   (`antigravityMapping.ts`), and a chat stays working while its files are
 *   written, since its transcript holds only the steps that are done.
 * - Needs you is a chat whose newest step waits for approval, from its
 *   database, read with `sqlite3` (`waits.ts`). What it asks is not read.
 * - Finished is every chat once the app's hub is not running, which needs
 *   `ps` and is known only on macOS.
 * - Failed is an error Antigravity records as a step of its own, or a reply
 *   that failed.
 * - The name is the title Antigravity gives a chat, and the folder the one its
 *   list of chats names, read with `sqlite3`.
 * - No Jump, Stop or Answer.
 * - Quiet for is the newest modified time of the chat's files.
 * - Tokens are the counts of the newest reply, from the transcript, as for
 *   the CLI (`transcriptFile.ts`).
 */
export const ANTIGRAVITY_APP_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": {
    level: "partly",
    reason:
      "While a chat waits for you to approve a step, read from its database with sqlite3, on macOS and Linux. What it asks is not shown.",
  },
  finished: {
    level: "partly",
    reason: "Once ps shows the app is closed, on macOS. Not on Linux or Windows yet.",
  },
  failed: {
    level: "partly",
    reason:
      "Only when Antigravity records an error of its own or a failed reply. A tool that fails shows as working.",
  },
  names: {
    level: "partly",
    reason:
      "The title Antigravity gives a chat, and the folder its list of chats names, read with sqlite3. Until then, its ID.",
  },
  jump: {
    level: "no",
    reason: "Antigravity documents no link that opens one of its chats.",
  },
  "quiet-for": { level: "yes" },
  tokens: { level: "yes" },
  stop: {
    level: "no",
    reason: "The app runs every chat in one program, so no chat can be stopped alone.",
  },
  answer: {
    level: "no",
    reason: "Antigravity documents no way to answer one of its approvals from outside the app.",
  },
};

/** Everything the adapter touches outside itself. Tests replace these. */
export interface AntigravityAppAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** What asks `ps` whether the app runs. Defaults to `ps` itself, on macOS. */
  hub?: HubProcessReader;
  /** What reads each chat's folder from the app's list of chats. Defaults to `sqlite3`. */
  summaries?: SummariesReader;
  /** What reads whether each chat waits for the person from its database. Defaults to `sqlite3`. */
  waits?: WaitReader;
  /** The system, which says whether `ps` and `sqlite3` are asked. Defaults to this one. */
  platform?: NodeJS.Platform;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often, at most, `ps` is asked. Defaults to 10 seconds. */
  processCheckMs?: number;
  /** How often chats not written for a day are looked at again. Defaults to 30 seconds. */
  oldRefreshMs?: number;
}

/** Where the folder was named. */
type HomeFrom = "agent-lookout" | "default";

/** Whether a chat's files were written in the last few seconds: `WRITING_MS` either way, for a clock a little off. */
export function writtenJustNow(lastWriteAt: number | null, now: number): boolean {
  return lastWriteAt !== null && Math.abs(now - lastWriteAt) < WRITING_MS;
}

/**
 * Finds Antigravity 2.0's chats on this machine from the files the app keeps,
 * with nothing installed, no setting changed and nothing sent to the app.
 *
 * Antigravity 2.0, Google's desktop app with the Agent Manager, keeps its
 * chats in `~/.gemini/antigravity` laid out as the Antigravity CLI keeps its
 * own, so the same readers serve it (`../shared/`). It reads, read-only:
 *
 * - The folder names under `brain` and `conversations`, and the modified
 *   times of each chat's transcript, database and database log.
 * - The end of each transcript written in the last 24 hours, for the last step.
 * - Each listed chat's title, from `annotations/<id>.pbtxt`.
 * - Each chat's folder, from `conversation_summaries.db`, with `sqlite3`
 *   (`summaries.ts`).
 * - Whether each listed chat waits for the person, from the number and status
 *   of the newest step in its `conversations/<id>.db`, with `sqlite3`
 *   (`waits.ts`).
 * - `ps`, on macOS, for whether the app's hub runs (`hubProcess.ts`).
 *
 * Where it differs from the CLI's: the app runs every chat in one program, so
 * every chat is open while it runs and finished once it does not; Needs you
 * comes from the chat's database, not a log; and a chat whose last step reads as idle is working
 * while its files are written, since steps not done are not in its
 * transcript yet.
 *
 * Antigravity not being installed costs nothing: when its folder is missing,
 * the adapter says so and looks again only once a minute, with a single
 * `stat`, and runs neither `ps` nor `sqlite3`.
 *
 * The folder is `AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME` if set, otherwise
 * `~/.gemini/antigravity`. Someone who sets the variable means that folder: if
 * it holds no chats, that is an answer, not a missing app.
 */
export function createAntigravityAppAdapter(options: AntigravityAppAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const hub = options.hub ?? createHubProcessReader({ platform });

  const homeFrom: HomeFrom = env[ANTIGRAVITY_APP_HOME_ENV]?.trim() ? "agent-lookout" : "default";
  const home = appHomeFor(env, homeDir);
  const brainDir = path.join(home, BRAIN_DIR);
  const homeName = tildify(home, homeDir);
  const brainName = tildify(brainDir, homeDir);
  const summariesName = tildify(path.join(home, SUMMARIES_FILE), homeDir);

  const finder = createConversationFinder({ home, io, oldRefreshMs: options.oldRefreshMs });
  const reader = createTranscriptReader(io);
  const titles = createTitleReader({ home, io });
  const summaries = options.summaries ?? createSummariesReader({ home, io, platform });
  const waits = options.waits ?? createWaitReader({ platform });

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** True once the folder has been seen, until its `brain` folder goes missing. */
  let homeSeen = false;
  /** What `ps` last said, and when. Null before it was first asked. */
  let lastHub: HubAnswer | null = null;
  let hubAt: number | null = null;

  const system = platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : "this system";
  const commandRun =
    platform === "darwin" ? `${every(processCheckMs)} at most` : `not run on ${system}`;
  const foldersRead =
    platform === "win32" ? "not on Windows" : "with sqlite3, when the file changes";
  const waitsRead =
    platform === "win32" ? "not on Windows" : "with sqlite3, when a chat's database changes";
  /** What the card always says, after how it reads. */
  const alwaysNotes = `${platform === "win32" ? WINDOWS_NEEDS_YOU_NOTE : NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;

  function watching(read: string): SourceFact[] {
    return [
      { label: "Conversations folder", value: brainName },
      { label: "Read", value: read },
      { label: "Command", value: `ps ${HUB_TABLE_ARGS.join(" ")}` },
      { label: "Command run", value: commandRun },
      { label: "Folders file", value: summariesName },
      { label: "Folders read", value: foldersRead },
      { label: "Waits read", value: waitsRead },
    ];
  }

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    basis: string = BASIS,
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: watching(read),
      checkedAt,
    };
    return state === "ok" ? { health, sessions: [], basis } : { health, sessions: [] };
  }

  /** Antigravity is not on this machine. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    lastHub = null;
    hubAt = null;
    return result(
      "unavailable",
      `Antigravity was not found: there is no ${homeName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** Whether the folder is there. Only a folder that is missing, or is not a folder, counts as not there. */
  async function homeIsThere(): Promise<boolean> {
    try {
      return (await io.stat(home)).kind === "directory";
    } catch (error) {
      return !isMissing(error);
    }
  }

  /**
   * Asks `ps` again when it is due: every 10 seconds, and sooner when a chat
   * was written after it last said the app was closed. Null when no chat is
   * to be shown, so it is not asked.
   */
  async function hubFor(
    conversations: readonly ConversationFiles[],
    checkedAt: number,
  ): Promise<HubAnswer | null> {
    if (!conversations.some((files) => writtenRecently(files, checkedAt))) return null;
    const since = hubAt === null ? Infinity : checkedAt - hubAt;
    let due = since < 0 || since >= processCheckMs;
    if (!due && since >= PROMPT_PROCESS_CHECK_MS && lastHub?.ok && !lastHub.running) {
      due = conversations.some(
        (files) => files.writtenAt !== null && files.writtenAt > (hubAt as number),
      );
    }
    if (due) {
      lastHub = await hub.read();
      hubAt = checkedAt;
    }
    return lastHub;
  }

  /** What the card adds when the folders could not be read, or nothing. */
  function foldersNote(state: SummariesState | null): string {
    if (state === "no-sqlite") {
      return ` No sqlite3 program was found to read each chat's folder from ${summariesName}, or whether it waits for you, so chats show without one and never as needing you.`;
    }
    if (state === "failed") {
      return ` sqlite3 could not read each chat's folder from ${summariesName}, so chats show without one.`;
    }
    return "";
  }

  /**
   * What the card adds when whether a chat waits could not be read, or
   * nothing. A missing sqlite3 is said once: by the folders' note when it
   * said so.
   */
  function waitsNote(failed: boolean, noSqlite: boolean, folders: SummariesState | null): string {
    let note = "";
    if (noSqlite && folders !== "no-sqlite") {
      note +=
        " No sqlite3 program was found to read whether a chat waits for you, so none shows as needing you.";
    }
    if (failed) {
      note +=
        " sqlite3 could not read whether some chats wait for you, so they show as working or idle.";
    }
    return note;
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing folder is believed missing for a while, so a machine without
    // Antigravity pays nothing on most polls. A clock set back counts as time enough.
    if (homeFrom !== "agent-lookout" && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }
    if (homeFrom !== "agent-lookout" && !homeSeen) {
      if (!(await homeIsThere())) {
        absentAt = checkedAt;
        return notFound(checkedAt);
      }
      absentAt = null;
      homeSeen = true;
    }

    // Every chat may be open while the app runs, but only those of the last
    // day are looked at on every poll, as for the CLI: the rest every 30 seconds.
    const listing = await finder.list(checkedAt, () => false);
    if (listing.state === "unreadable") {
      return result(
        "error",
        `Antigravity chats could not be read: the folder ${brainName} could not be listed.`,
        "cannot be read",
        checkedAt,
      );
    }
    if (listing.state === "missing") {
      if (homeFrom === "agent-lookout") {
        return result(
          "ok",
          `${ANTIGRAVITY_APP_HOME_ENV} is set to ${homeName}, which has no ${BRAIN_DIR} folder, so no Antigravity sessions are listed. ${alwaysNotes}`,
          "not found",
          checkedAt,
        );
      }
      // The folder itself may have gone with its `brain` folder.
      homeSeen = false;
      if (!(await homeIsThere())) {
        absentAt = checkedAt;
        return notFound(checkedAt);
      }
      homeSeen = true;
      return result(
        "ok",
        `Antigravity has not saved any chats in ${brainName} yet. ${alwaysNotes}`,
        "not found",
        checkedAt,
      );
    }

    const { conversations } = listing;
    const shown = conversations.filter(
      (files) => files.transcriptInfo !== null && writtenRecently(files, checkedAt),
    );
    // Null only when no chat is to be shown.
    const answer = await hubFor(conversations, checkedAt);
    const read = shown.length > 0 ? await summaries.read(checkedAt) : null;

    /** The transcripts read this poll, whose cache is worth keeping. */
    const kept = new Set<string>();
    const sessions: Session[] = [];
    let unknownStep = false;
    let waitFailed = false;
    let waitNoSqlite = false;
    for (const files of shown) {
      if (files.transcriptInfo === null) continue;
      let state: TranscriptState;
      try {
        state = await reader.read(files.transcript, files.transcriptInfo);
      } catch {
        // Unreadable this time. What was read of it before is kept for the next poll.
        kept.add(files.transcript);
        continue;
      }
      kept.add(files.transcript);
      const live = hubLiveness(answer, hubAt, files.writtenAt);
      // A chat of an app that is closed is finished, so its database is not read.
      const wait: Wait =
        live === false
          ? { state: "not-read" }
          : await waits.read(
              files.id,
              files.database,
              files.databaseInfo,
              files.logThere,
              checkedAt,
            );
      if (wait.state === "failed") waitFailed = true;
      if (wait.state === "no-sqlite") waitNoSqlite = true;
      const session = antigravitySession({
        profile: APP_PROFILE,
        conversationId: files.id,
        state,
        live,
        waiting: wait.state === "waiting" ? { tool: null, since: wait.since } : null,
        title: await titles.read(files.id),
        folder: read?.folders.get(files.id) ?? null,
        writtenAt: files.lastWriteAt,
        writing: writtenJustNow(files.lastWriteAt, checkedAt),
        now: checkedAt,
      });
      if (session.status === "unknown") unknownStep = true;
      sessions.push(session);
    }
    reader.keepOnly(kept);
    const shownIds = new Set(sessions.map((session) => session.id.slice(SOURCE_ID.length + 1)));
    titles.keepOnly(shownIds);
    waits.keepOnly(shownIds);

    let detail = `Sessions are read from the transcripts Antigravity keeps in ${brainName}. ${alwaysNotes}`;
    let basis = BASIS;
    if (answer !== null && !answer.ok) {
      detail +=
        platform === "darwin"
          ? " ps could not be run to tell whether Antigravity is open, so no chat is shown as finished"
          : ` On ${system} Agent Lookout cannot tell yet whether Antigravity is open, so no chat is shown as finished`;
      // A chat left waiting goes on needing you only where waits are read.
      const waitsKnown = platform !== "win32" && !waitNoSqlite && read?.state !== "no-sqlite";
      detail += waitsKnown
        ? ", and one left waiting when the app quit still shows as needing you, for up to a day."
        : ".";
      basis = BASIS_WITHOUT_PROCESSES;
    } else if (answer?.ok && !answer.running) {
      basis = BASIS_APP_CLOSED;
    }
    detail += foldersNote(read?.state ?? null);
    detail += waitsNote(waitFailed, waitNoSqlite, read?.state ?? null);
    if (unknownStep) detail += ` ${UNKNOWN_STEP_NOTE}`;
    const answered = result("ok", detail, every(pollIntervalMs), checkedAt, basis);
    return { ...answered, sessions };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: ANTIGRAVITY_APP_CAPABILITIES,
    lookingIn: `Looking for Antigravity sessions in ${brainName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Antigravity sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
