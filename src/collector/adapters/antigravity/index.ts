import os from "node:os";
import path from "node:path";

import {
  antigravityLiveness,
  holdConversations,
  type AgySessionProcess,
  type Holding,
} from "../../../core/mapping/antigravityLiveness.ts";
import {
  agyLogTimeAt,
  waitsForApproval,
  type AgyLogState,
} from "../../../core/mapping/antigravityLog.ts";
import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import { createAgyLogReader } from "./agyLogs.ts";
import {
  AGY_TABLE_ARGS,
  createAgyProcessReader,
  type AgyProcessList,
  type AgyProcessReader,
} from "./agyProcesses.ts";
import {
  BRAIN_DIR,
  createConversationFinder,
  writtenRecently,
  type ConversationFiles,
} from "./conversations.ts";
import { createTitleReader } from "./annotations.ts";
import { createOtherFolderCheck } from "./otherFolders.ts";
import { antigravitySession, SOURCE_ID } from "./toSession.ts";
import { createTranscriptReader, type TranscriptState } from "./transcriptFile.ts";

/** The variable that replaces the Antigravity CLI's folder, for Agent Lookout alone. */
export const ANTIGRAVITY_HOME_ENV = "AGENT_LOOKOUT_ANTIGRAVITY_HOME";

/** Where the Antigravity CLI keeps its files, under the home folder. */
export const DEFAULT_HOME = [".gemini", "antigravity-cli"] as const;

/** How long a folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked which agy programs run, while there are conversations to show. */
export const PROCESS_CHECK_MS = 10_000;

/**
 * How soon `ps` is asked again when a conversation is written that no agy
 * program known to run could have open, as when agy has just started.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/** The usual way this adapter reads, named for the poller. */
export const BASIS = "files";

/**
 * The way it reads while `ps` cannot say which agy programs run, as on
 * Windows. Then no conversation is shown as finished, so one that had finished
 * shows as idle. Named apart, so that such a poll is compared only with polls
 * read the same way, and every finished conversation does not seem to start
 * again and then finish.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

/**
 * The way it reads while an agy program runs that could have any conversation
 * open, because it has written to none since it started. No conversation is
 * shown as finished then either, so it is named apart for the same reason.
 */
export const BASIS_UNMATCHED = "files-unmatched";

const LABEL = "Antigravity CLI";

/** Said whenever the Antigravity CLI is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "A session needs you while agy asks you to approve a tool, which its own log records. A question it asks you is not known to be recorded, so it shows as working.";

/** Said whenever the Antigravity CLI is watched, until the adapter has been checked against more of agy. */
export const UNCHECKED_NOTE =
  "This was checked against one agy 1.3.1 conversation, and parts of it, such as /resume, are not yet checked, so a status can be wrong.";

/** What the card always says, after how it reads. */
const ALWAYS_NOTES = `${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;

/** Said when a conversation's last step is one this adapter does not know, or none could be read. */
export const UNKNOWN_STEP_NOTE =
  "Some conversations end with a step Agent Lookout does not know, perhaps from a newer agy, so they show as unknown.";

/** Said while an agy program runs that has written to no conversation since it started. */
export const UNMATCHED_NOTE =
  "An agy program is running that has not written to a conversation since it started, so none is shown as finished until it does.";

/**
 * What an Antigravity CLI session can show, from the files this adapter reads
 * and `ps`. See docs/adapters/antigravity.md for each. None of it has been
 * checked against a running conversation yet: it is built from what agy 1.3.1
 * documents and its program holds.
 *
 * - Working and idle are the transcript's last step (`antigravityMapping.ts`).
 * - Needs you is an approval its program's log says it waits for
 *   (`antigravityLog.ts`). A question it asks shows as working.
 * - Finished is a conversation no agy program running could have open
 *   (`antigravityLiveness.ts`), which needs `ps`.
 * - Failed is an error agy records as a step of its own, or a reply that failed.
 * - The name is the title agy gives a conversation, and the folder the one its
 *   program's log names.
 * - No Jump, Stop or Answer: nothing ties a conversation to one terminal, and
 *   agy takes its answers only in that terminal.
 * - Quiet for is the newest modified time of the conversation's files.
 * - Tokens are not read: where agy's transcripts record them has not been
 *   checked.
 */
export const ANTIGRAVITY_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "yes" },
  "needs-you": {
    level: "partly",
    reason:
      "While agy asks you to approve a tool, from its own log. A question it asks you shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once ps shows no agy program running that could have the conversation open. Not on Windows.",
  },
  failed: {
    level: "partly",
    reason:
      "Only when agy records an error of its own or a failed reply. A tool that fails shows as working.",
  },
  names: {
    level: "partly",
    reason:
      "The title agy gives a conversation once it has one, and the folder its program's log names. Until then, its conversation ID.",
  },
  jump: {
    level: "no",
    reason:
      "The transcripts name no terminal, and agy documents no link that opens a conversation.",
  },
  "quiet-for": { level: "yes" },
  tokens: {
    level: "no",
    reason: "Agent Lookout does not read token counts from agy's transcripts yet.",
  },
  stop: {
    level: "no",
    reason:
      "No agy program is tied to one conversation surely enough for Agent Lookout to confirm it and stop it.",
  },
  answer: {
    level: "no",
    reason: "Its approval prompt takes an answer only in the terminal agy runs in.",
  },
};

/** Everything the adapter touches outside itself. Tests replace these. */
export interface AntigravityAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** What asks `ps` which agy programs run. Defaults to `ps` itself. */
  processes?: AgyProcessReader;
  /** The system, which on Windows means there is no `ps` to ask. Defaults to this one. */
  platform?: NodeJS.Platform;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   */
  pollIntervalMs?: number;
  /**
   * How long a missing folder is believed missing before one more look, and
   * how long the answer about the Antigravity IDE's and Antigravity 2.0's
   * folders stands. Defaults to a minute.
   */
  recheckMs?: number;
  /** How often, at most, `ps` is asked. Defaults to 10 seconds. */
  processCheckMs?: number;
  /** How often conversations not written for a day are looked at again. Defaults to 30 seconds. */
  oldRefreshMs?: number;
}

/** Where the folder was named. */
type HomeFrom = "agent-lookout" | "default";

/**
 * The programs as `ps` gave them, each with the conversation its log says it
 * has open now, which is surer than the one its command line named before
 * any `/new` or `/resume`.
 */
export function withLoggedConversations(
  programs: readonly AgySessionProcess[],
  logStates: readonly (AgyLogState | null)[],
): AgySessionProcess[] {
  return programs.map((program, index) => {
    const current = logStates[index]?.current ?? null;
    return current === null ? program : { ...program, conversation: current };
  });
}

/**
 * The folder a conversation's program works in: from the log of the program
 * that has it open now, else of one that opened it. Null when no log says.
 */
export function folderOf(id: string, logs: readonly AgyLogState[]): string | null {
  const open = logs.find((log) => log.current === id && log.folder !== null);
  if (open) return open.folder;
  return logs.find((log) => log.opened.has(id) && log.folder !== null)?.folder ?? null;
}

/**
 * Finds Antigravity CLI conversations on this machine from the files agy
 * keeps, with nothing installed, no setting changed and no agy program run.
 *
 * agy documents its transcripts, for its own agents and hooks to read, but no
 * listing for an outside program. Its hooks and its status line would each
 * need a change to its settings. So the adapter reads, read-only:
 *
 * - The folder names under `<agy folder>/brain` and `<agy folder>/conversations`,
 *   and the modified times of each conversation's transcript, database and
 *   database log. See `conversations.ts`.
 * - The end of each transcript written in the last 24 hours, or that an agy
 *   program may have open, for the last step.
 *   See `transcriptFile.ts`.
 * - `ps`, for which agy programs run, to tell an open conversation from one
 *   that has ended. See `agyProcesses.ts`.
 *
 * A conversation is listed while an agy program may have it open, and for 24
 * hours after its transcript was last written. Its status is working, idle,
 * failed or finished, never "needs-you".
 *
 * agy not being installed costs nothing: when its folder is missing, the
 * adapter says so and looks again only once a minute, with a single `stat`,
 * and runs no `ps`.
 *
 * It also looks, once a minute at most, with one `lstat` each, whether the
 * Antigravity IDE's folder or Antigravity 2.0's is beside the CLI's, and the
 * card says so, since it reads neither yet. See `otherFolders.ts`.
 *
 * The folder is `AGENT_LOOKOUT_ANTIGRAVITY_HOME` if set, otherwise
 * `~/.gemini/antigravity-cli`. Someone who sets the variable means that
 * folder: if it holds no conversations, that is an answer, not a missing agy.
 */
export function createAntigravityAdapter(options: AntigravityAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const processes = options.processes ?? createAgyProcessReader({ platform });

  const override = env[ANTIGRAVITY_HOME_ENV]?.trim() || undefined;
  const homeFrom: HomeFrom = override ? "agent-lookout" : "default";
  const home = path.resolve(override ?? path.join(homeDir, ...DEFAULT_HOME));
  const brainDir = path.join(home, BRAIN_DIR);
  const homeName = tildify(home, homeDir);
  const brainName = tildify(brainDir, homeDir);

  const finder = createConversationFinder({ home, io, oldRefreshMs: options.oldRefreshMs });
  const reader = createTranscriptReader(io);
  const logs = createAgyLogReader({ home, io, now });
  const titles = createTitleReader({ home, io });
  const others = createOtherFolderCheck({
    home,
    io,
    recheckMs,
    platform,
    name: (target) => tildify(target, homeDir),
  });

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** True once the folder has been seen, until its `brain` folder goes missing. */
  let homeSeen = false;
  /** What `ps` last said, and when. Null before it was first asked. */
  let lastProcesses: AgyProcessList | null = null;
  let processesAt: number | null = null;
  /** The conversations an agy program may have open, as last worked out. */
  let lastHolding: Holding | null = null;
  /** What the card says of the Antigravity IDE's and Antigravity 2.0's folders, as last looked at. Null while neither is there. */
  let othersNote: string | null = null;

  const commandRun =
    platform === "win32" ? "not run on Windows" : `${every(processCheckMs)} at most`;

  function watching(read: string): SourceFact[] {
    return [
      { label: "Conversations folder", value: brainName },
      { label: "Read", value: read },
      { label: "Command", value: `ps ${AGY_TABLE_ARGS.join(" ")}` },
      { label: "Command run", value: commandRun },
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
      // Last, so it reads after what is said of the CLI, whatever that is.
      detail: othersNote === null ? detail : `${detail} ${othersNote}`,
      watching: watching(read),
      checkedAt,
    };
    return state === "ok" ? { health, sessions: [], basis } : { health, sessions: [] };
  }

  /** The Antigravity CLI is not on this machine. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    lastProcesses = null;
    processesAt = null;
    lastHolding = null;
    return result(
      "unavailable",
      `The Antigravity CLI was not found: there is no ${homeName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
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
   * Asks `ps` again when it is due: every 10 seconds, and sooner when a
   * conversation was written since the last answer that no program in it
   * could have open.
   */
  async function processesFor(
    conversations: readonly ConversationFiles[],
    checkedAt: number,
  ): Promise<AgyProcessList | null> {
    const shown = conversations.some(
      (files) => writtenRecently(files, checkedAt) || lastHolding?.held.has(files.id),
    );
    if (!shown) return null;
    const since = processesAt === null ? Infinity : checkedAt - processesAt;
    let due = since < 0 || since >= processCheckMs;
    if (!due && since >= PROMPT_PROCESS_CHECK_MS && lastProcesses?.ok) {
      const holding = holdConversations(lastProcesses.sessions, conversations);
      due = conversations.some(
        (files) =>
          files.writtenAt !== null &&
          files.writtenAt > (processesAt as number) &&
          !holding.held.has(files.id),
      );
    }
    if (due) {
      lastProcesses = await processes.read();
      processesAt = checkedAt;
    }
    return lastProcesses;
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing folder is believed missing for a while, so a machine without
    // agy pays nothing on most polls. A clock set back counts as time enough.
    if (homeFrom !== "agent-lookout" && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }
    // After that, so that while the folder is missing the other two are
    // looked at only on a poll that looks for it too.
    othersNote = await others.note(checkedAt);
    if (homeFrom !== "agent-lookout" && !homeSeen) {
      if (!(await homeIsThere())) {
        absentAt = checkedAt;
        return notFound(checkedAt);
      }
      absentAt = null;
      homeSeen = true;
    }

    const listing = await finder.list(checkedAt, (id) => lastHolding?.held.has(id) ?? false);
    if (listing.state === "unreadable") {
      return result(
        "error",
        `Antigravity CLI conversations could not be read: the folder ${brainName} could not be listed.`,
        "cannot be read",
        checkedAt,
      );
    }
    if (listing.state === "missing") {
      lastHolding = null;
      if (homeFrom === "agent-lookout") {
        return result(
          "ok",
          `${ANTIGRAVITY_HOME_ENV} is set to ${homeName}, which has no ${BRAIN_DIR} folder, so no Antigravity CLI sessions are listed. ${ALWAYS_NOTES}`,
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
        `The Antigravity CLI has not saved any conversations in ${brainName} yet. ${ALWAYS_NOTES}`,
        "not found",
        checkedAt,
      );
    }

    const { conversations } = listing;
    // Null only when no conversation is to be shown, and so none is listed below.
    const list = await processesFor(conversations, checkedAt);
    // Each running program's log, read on every poll, so a wait shows at once.
    const logStates = list?.ok ? await logs.read(list.sessions) : [];
    const programs = list?.ok ? withLoggedConversations(list.sessions, logStates) : [];
    // When `ps` was not asked this poll, a conversation written since it last
    // was may be open in an agy program started since, which it did not show.
    const holding = list?.ok ? holdConversations(programs, conversations, processesAt) : null;
    lastHolding = holding;
    const logged = logStates.filter((state): state is AgyLogState => state !== null);

    /** The transcripts read this poll, whose cache is worth keeping. */
    const read = new Set<string>();
    const sessions: Session[] = [];
    let unknownStep = false;
    for (const files of conversations) {
      const open = holding?.held.has(files.id) ?? false;
      if (files.transcriptInfo === null || !(open || writtenRecently(files, checkedAt))) continue;
      let state: TranscriptState;
      try {
        state = await reader.read(files.transcript, files.transcriptInfo);
      } catch {
        // Unreadable this time. What was read of it before is kept for the next poll.
        read.add(files.transcript);
        continue;
      }
      read.add(files.transcript);
      const ask = logged.find((log) => log.ask?.conversation === files.id)?.ask ?? null;
      const waiting =
        ask !== null && waitsForApproval(ask, files.id, state.lastIndex)
          ? { tool: ask.tool, since: agyLogTimeAt(ask.at, checkedAt) }
          : null;
      const session = antigravitySession({
        conversationId: files.id,
        state,
        live: antigravityLiveness(files.id, holding),
        waiting,
        title: await titles.read(files.id),
        folder: folderOf(files.id, logged),
        writtenAt: files.lastWriteAt,
        now: checkedAt,
      });
      if (session.status === "unknown") unknownStep = true;
      sessions.push(session);
    }
    reader.keepOnly(read);
    titles.keepOnly(new Set(sessions.map((session) => session.id.slice(SOURCE_ID.length + 1))));

    let detail = `Sessions are read from the transcripts the Antigravity CLI keeps in ${brainName}. ${ALWAYS_NOTES}`;
    let basis = BASIS;
    if (list !== null && !list.ok) {
      detail +=
        platform === "win32"
          ? " Windows has no ps to tell which conversations agy has open, so none is shown as finished."
          : " ps could not be run to tell which conversations agy has open, so none is shown as finished.";
      basis = BASIS_WITHOUT_PROCESSES;
    } else if (holding !== null && !holding.complete) {
      detail += ` ${UNMATCHED_NOTE}`;
      basis = BASIS_UNMATCHED;
    }
    if (unknownStep) detail += ` ${UNKNOWN_STEP_NOTE}`;
    const answer = result("ok", detail, every(pollIntervalMs), checkedAt, basis);
    return { ...answer, sessions };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: ANTIGRAVITY_CAPABILITIES,
    lookingIn: `Looking for Antigravity CLI sessions in ${brainName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Antigravity CLI sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
