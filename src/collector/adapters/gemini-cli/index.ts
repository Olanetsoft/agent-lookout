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
import { lastMessageStoppedBy } from "../../messages/lastMessageSettings.ts";
import type { TailLimits } from "../../messages/tailReader.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import { createChatFileReader, type ChatFileState } from "./chatFile.ts";
import { createChatLister } from "./chats.ts";
import { createGeminiCliLastMessages } from "./lastMessages.ts";
import { createProjectLister, type Project, type ProjectLister } from "./projects.ts";
import { createSubagentWrites, subagentFolder, type SubagentsUnread } from "./subagentWrites.ts";
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

/**
 * The folder in a home folder that holds Gemini CLI's folder under macOS
 * Seatbelt, as `.cache/.gemini` (`getGlobalRuntimeDir` in
 * packages/core/src/config/storage.ts at v0.64.0).
 */
export const SEATBELT_PARENT_DIR = ".cache";

/** The folder in Gemini CLI's folder that holds every project's sessions. */
export const TMP_DIR = "tmp";

/** How long Gemini CLI is taken to be still missing, when none of its folders holds `tmp/`, before each `tmp/` is looked for again. */
export const RECHECK_MS = 60_000;

/** The one way this adapter reads, named for the poller. */
export const BASIS = "files";

const LABEL = "Gemini CLI";

/** What Sources says of a subagent's files. */
export const SUBAGENT_FILES = "chats/<session id>/*.jsonl, looked up and never opened";

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

const sessionCount = (count: number) => (count === 1 ? "1 session" : `${count} sessions`);

/**
 * Said when subagents' folders or files could not be looked up this poll, or
 * null when all could. It gives the kind of failure and how many sessions it
 * touched, and never names a session, a folder or a file.
 */
export function subagentsUnreadNote({ refused, failed }: SubagentsUnread): string | null {
  const kinds: string[] = [];
  if (refused > 0) kinds.push(`permission was refused for ${sessionCount(refused)}`);
  if (failed > 0) kinds.push(`the lookup failed for ${sessionCount(failed)}`);
  if (kinds.length === 0) return null;
  return `Subagent files could not be looked up: ${kinds.join(", and ")}. Such a session can look quiet while a subagent works, and in the Mac app Keep awake can stop counting it.`;
}

/**
 * What a Gemini CLI session can show, from the files this adapter reads. See
 * docs/adapters/gemini-cli.md for each.
 *
 * - Working and idle partly: Gemini CLI writes a tool call only once it ends,
 *   so a reply with text whose tool still waits or runs reads as a final answer.
 * - Needs you never: approval waits are never written to its files.
 * - Finished never: it writes no lock and no mark when a session ends, so a
 *   closed session keeps its last status, working when it closed mid-turn.
 * - Failed partly: an `error` message says a request failed only by how its
 *   text begins, and `gemini -p` records no error at all.
 * - Its name is the title Gemini CLI saves at a later start in the same folder.
 * - No Jump: the files name no process or terminal.
 * - Quiet for is the newest modified time of the session's file and its
 *   subagents' files, each moved on by every line (`subagentWrites.ts`).
 * - Tokens are the counts of the newest reply left that has them, from the
 *   same read of the session file (`summaryCountsOf` in `chatFile.ts`).
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
      "Gemini CLI writes no end mark, so a closed session keeps its last status until a day after its last update.",
  },
  failed: {
    level: "partly",
    reason:
      "When a request ends on an error Gemini CLI records. One that fails under gemini -p records none, so it shows as idle or working.",
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
  tokens: { level: "yes" },
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
 * Gemini CLI's own folder, the one that holds `tmp/`: the one
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

/**
 * The folder Gemini CLI keeps its sessions in under macOS Seatbelt, read
 * beside the other, or null where none is: `.cache/.gemini` in the same home
 * folder, Gemini CLI's own `GEMINI_CLI_HOME` or else the person's. Gemini CLI
 * keeps them there when `SANDBOX` is `sandbox-exec`, which in Gemini CLI's
 * code only its start under macOS's `sandbox-exec` sets, so it is read on a
 * Mac alone. Agent Lookout cannot tell whether a session ran under Seatbelt,
 * so it reads both folders with no setting. With
 * `AGENT_LOOKOUT_GEMINI_CLI_HOME` set, only the folder it names is read.
 */
export function geminiCliSeatbeltFolder(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "darwin" || env[GEMINI_CLI_HOME_ENV]?.trim()) return null;
  const geminiHome = env[GEMINI_CLI_OWN_HOME_ENV]?.trim() || undefined;
  return path.resolve(geminiHome ?? homeDir, SEATBELT_PARENT_DIR, DEFAULT_DIR);
}

/** One folder of Gemini CLI's that holds `tmp/`. */
interface Folder {
  /** Whether it is the one Gemini CLI keeps under macOS Seatbelt. */
  seatbelt: boolean;
  tmpDir: string;
  /** `tmp/` as people see it, such as `~/.gemini/tmp`. */
  tmpName: string;
  projects: ProjectLister;
}

/** A project, with the folder it was found in. */
type FolderProject = Project & { seatbelt: boolean };

/** A folder that is there and could not be read this poll, and what could not be done to it. */
interface Unread {
  folder: Folder;
  could: "looked at" | "listed";
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface GeminiCliAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** The system, which says whether the folder Gemini CLI keeps under macOS Seatbelt is read. Defaults to this one. */
  platform?: NodeJS.Platform;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   * Defaults to the poller's interval.
   */
  pollIntervalMs?: number;
  /** How long Gemini CLI is believed missing, when no folder holds `tmp/`, before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often, at most, `tmp/` and each folder of session files are listed again. Defaults to 30 seconds. */
  listRefreshMs?: number;
  /**
   * The limits its reader of last messages shares with the other agents'
   * readers. The collector passes one for them all. Left out, it has its own.
   */
  lastMessageLimits?: TailLimits;
}

/** The Gemini CLI adapter, which reads what its sessions last said when asked. */
export interface GeminiCliAdapter extends Adapter {
  lastMessage: NonNullable<Adapter["lastMessage"]>;
  /**
   * How many sessions it keeps a last message for, in memory. For the tests
   * that check none is kept once its session has left the list.
   */
  readonly lastMessagesKept: number;
  /**
   * How many sessions' subagent folders it keeps file names for, in memory. For
   * the tests that check none is kept once its session has left the list.
   */
  readonly subagentFoldersKept: number;
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
 * - The folder of each session it lists, `chats/<session id>/`, listed, for when
 *   the session's subagents last wrote, from their files' modified times. Those
 *   files are never opened (`subagentWrites.ts`). A folder or file that cannot
 *   be looked up leaves the session listed from its own file, and `detail` says
 *   so on each poll that finds it so.
 *
 * On a Mac it reads them in two folders: Gemini CLI's own, and the one it
 * keeps its sessions in under macOS Seatbelt, `~/.cache/.gemini`
 * (`geminiCliSeatbeltFolder`). Each folder has its own projects, so a session
 * in each is a session of its own, with an id of its own. The two can be one
 * folder, through a link, and are then read once, as the first.
 *
 * A session is listed for 24 hours after its last update. Its status is
 * working, idle, failed or unknown, never "needs-you" or "finished": Gemini
 * CLI writes nothing to a session's file while a tool waits for approval or
 * runs, and nothing when a session ends. A subagent's own file is never listed,
 * and its writes move nothing but its session's last write. Two projects can
 * each hold a session of one id, which `--session-id` allows, so a session's id
 * names its project's folder too. Two files of one id in one project of one
 * folder are listed once, from the one active last, as Gemini CLI's own list
 * shows them.
 *
 * What a session last said is read from the end of the file the last poll
 * listed it from, but only when `lastMessage` is asked for it, which the
 * route does while a page has the session's details open, and only for a
 * session the last poll listed (`lastMessages.ts`). No poll reads it, and it
 * is never put on a session. `AGENT_LOOKOUT_LAST_MESSAGE=off` stops it, and so
 * does `AGENT_LOOKOUT_WAITING_TEXT=off`, which says no transcript is read.
 *
 * Gemini CLI not being installed costs nothing: when no folder holds `tmp/`,
 * the adapter says so and looks again only once a minute, with a single
 * `stat` of each `tmp/`. While one is there, the other's is looked at on each
 * poll with a single `stat`, and nothing more while it is missing. Someone who
 * sets `AGENT_LOOKOUT_GEMINI_CLI_HOME` means that folder alone: if it holds no
 * sessions, that is an answer, not a missing Gemini CLI.
 *
 * Built from Gemini CLI's source at v0.64.0, and not yet checked against a
 * machine running it.
 */
export function createGeminiCliAdapter(options: GeminiCliAdapterOptions = {}): GeminiCliAdapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;

  const { dir: geminiDir, from: homeFrom } = geminiCliFolder(env, homeDir);
  const homeName = tildify(geminiDir, homeDir);
  const seatbeltDir = geminiCliSeatbeltFolder(env, homeDir, platform);

  function folderAt(dir: string, seatbelt: boolean): Folder {
    const tmpDir = path.join(dir, TMP_DIR);
    return {
      seatbelt,
      tmpDir,
      tmpName: tildify(tmpDir, homeDir),
      projects: createProjectLister({ tmpDir, io, platform, refreshMs: options.listRefreshMs }),
    };
  }
  const home = folderAt(geminiDir, false);
  const seatbeltFolder = seatbeltDir === null ? undefined : folderAt(seatbeltDir, true);
  /** Gemini CLI's own folder first, then, on a Mac, the one it keeps under Seatbelt. */
  const folders = seatbeltFolder ? [home, seatbeltFolder] : [home];

  const chats = createChatLister({ io, refreshMs: options.listRefreshMs });
  const reader = createChatFileReader(io);
  const subagents = createSubagentWrites({ io, refreshMs: options.listRefreshMs });
  // What a session last said, read only when it is asked for. With either
  // setting off, no file is opened for it.
  const lastMessagesOff = lastMessageStoppedBy(env);
  const lastMessages =
    lastMessagesOff === null
      ? createGeminiCliLastMessages({ io, now, limits: options.lastMessageLimits })
      : null;
  /** What Sources says of the last-message read: when it reads the end of a session's file, or Off. */
  const lastMessageRead =
    lastMessagesOff === null ? "end of a session's file, while its details are open" : "Off";
  /** The file this poll listed each session from, by its id: the only file its last message is read from. */
  let listedFiles = new Map<string, string>();

  /** When every `tmp/` was last found missing. Null while one is there, or before the first look. */
  let absentAt: number | null = null;

  const alwaysNotes = `${NEEDS_YOU_NOTE} ${FILES_ONLY_NOTE} ${UNCHECKED_NOTE}`;

  /** Each folder of sessions read, in words: `~/.gemini/tmp and ~/.cache/.gemini/tmp`. */
  const tmpNames = folders.map((folder) => folder.tmpName).join(" and ");

  function watching(read: string): SourceFact[] {
    const seatbelt: SourceFact[] = seatbeltFolder
      ? [{ label: "Seatbelt sessions folder", value: seatbeltFolder.tmpName }]
      : [];
    return [
      { label: "Sessions folder", value: home.tmpName },
      ...seatbelt,
      { label: "Read", value: read },
      { label: "Files read", value: "chats/session-*.jsonl and .project_root in each project" },
      { label: "Subagent files", value: SUBAGENT_FILES },
      { label: "Programs run", value: "None" },
      { label: "Last message read", value: lastMessageRead },
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
    const missing = folders.map((folder) => folder.tmpName).join(" or ");
    const where =
      homeFrom === "gemini-cli"
        ? `${GEMINI_CLI_OWN_HOME_ENV} is set, and there is no ${missing} folder`
        : `there is no ${missing} folder`;
    return result(
      "unavailable",
      `Gemini CLI was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** What could not be done to a folder, as part of a sentence. */
  const unreadWords = ({ folder, could }: Unread) =>
    `the folder ${folder.tmpName} could not be ${could}`;

  /**
   * Whether the folder Gemini CLI keeps under Seatbelt is its own folder,
   * through a link: its `tmp/` has the same identity on the disk, and, when
   * the system can say, the same path with every link followed, which reads
   * nothing in either. Two folders apart on one disk never share an identity,
   * so the path is asked only when they do.
   */
  async function sameAsHome(info: FileInfo, homeInfo: FileInfo | undefined): Promise<boolean> {
    if (seatbeltFolder === undefined || homeInfo === undefined) return false;
    if (info.ino !== homeInfo.ino) return false;
    if (io.realpath === undefined) return true;
    try {
      const [mine, theirs] = await Promise.all([
        io.realpath(seatbeltFolder.tmpDir),
        io.realpath(home.tmpDir),
      ]);
      return mine === theirs;
    } catch {
      return true;
    }
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Gemini CLI is believed missing for a while, so a machine
    // without it pays nothing on most polls. A clock set back counts as time enough.
    if (homeFrom !== "agent-lookout" && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    /** Each folder whose `tmp/` is there, with what its `stat` said. */
    const there: { folder: Folder; info: FileInfo }[] = [];
    /** Each folder that is there and could not be read this poll. */
    const unread: Unread[] = [];
    for (const folder of folders) {
      let info: FileInfo;
      try {
        // `tmp/` may be a link, as Gemini CLI's folder may be, so it is followed here.
        info = await io.stat(folder.tmpDir);
      } catch (error) {
        if (!isMissing(error)) unread.push({ folder, could: "looked at" });
        continue;
      }
      // Only a folder counts: `~/.gemini` alone does not, as Antigravity keeps its own files there.
      if (info.kind !== "directory") continue;
      // The folder kept under Seatbelt can be Gemini CLI's own, through a link.
      // It is then read once, as Gemini CLI's own, which is looked at first.
      if (folder.seatbelt && (await sameAsHome(info, there[0]?.info))) continue;
      there.push({ folder, info });
    }
    if (there.length === 0 && unread.length === 0) {
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

    const projects: FolderProject[] = [];
    for (const { folder, info } of there) {
      try {
        const found = await folder.projects.list(info, checkedAt);
        for (const project of found) projects.push({ ...project, seatbelt: folder.seatbelt });
      } catch {
        unread.push({ folder, could: "listed" });
      }
    }
    // A folder that is there and could not be read makes the whole poll an
    // error, though the other was read. The poller compares nothing from an
    // error, so no session in that folder is taken to have ended, and none to
    // have appeared again at the next poll that reads it.
    if (unread.length > 0) {
      return result(
        "error",
        `Gemini CLI sessions could not be read: ${unread.map(unreadWords).join(", and ")}.`,
        "cannot be read",
        checkedAt,
      );
    }
    // Every folder's projects at once, so neither forgets what it keeps of the other's.
    const listing = await chats.recent(projects, checkedAt);

    /** The files read this poll, whose cache is worth keeping. */
    const read = new Set<string>();
    /** The file to show for each session, by folder, project and id: a session saved twice has more than one. */
    const chosen = new Map<
      string,
      {
        state: ChatFileState;
        project: FolderProject;
        at: number;
        writtenAt: number;
        file: string;
        subagentDir: string;
      }
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
      // Gemini CLI tells sessions apart by id within one project's folder of
      // one of its folders alone: `--resume` looks in no other.
      const key = `${ref.project.seatbelt ? "seatbelt" : "home"}/${ref.project.slug}/${header.sessionId}`;
      const kept = chosen.get(key);
      if (!kept || at > kept.at) {
        chosen.set(key, {
          state,
          project: ref.project,
          at,
          writtenAt: ref.info.mtimeMs,
          file: ref.path,
          subagentDir: subagentFolder(ref.project.dir, header.sessionId),
        });
      }
    }
    reader.keepOnly(read);

    // Only the folders of the sessions this poll lists. A subagent's writes count
    // as its session's, since the session writes nothing while it waits on one.
    const subagentLook = await subagents.newest(
      [...chosen.values()].map(({ subagentDir }) => subagentDir),
      checkedAt,
    );

    const sessions: Session[] = [];
    for (const { state, project, writtenAt, file, subagentDir } of chosen.values()) {
      const { slug, seatbelt, cwd } = project;
      const session = geminiCliSession({
        state,
        slug,
        seatbelt,
        cwd,
        writtenAt,
        subagentWrittenAt: subagentLook.times.get(subagentDir),
        now: checkedAt,
      });
      if (session) {
        sessions.push(session);
        listedFiles.set(session.id, file);
      }
    }

    let detail = `Sessions are read from the files Gemini CLI saves in ${home.tmpName}`;
    if (seatbeltFolder) detail += `, and in ${seatbeltFolder.tmpName} under macOS Seatbelt`;
    detail += `. ${alwaysNotes}`;
    if (listing.older > 0) detail += ` ${OLDER_FORMAT_NOTE}`;
    if (sessions.some((session) => session.status === "unknown")) detail += ` ${UNKNOWN_NOTE}`;
    const unreadNote = subagentsUnreadNote(subagentLook.unread);
    if (unreadNote !== null) detail += ` ${unreadNote}`;
    const answer = result("ok", detail, every(pollIntervalMs), checkedAt);
    return { ...answer, sessions };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: GEMINI_CLI_CAPABILITIES,
    lookingIn: `Looking for Gemini CLI sessions in ${tmpNames}.`,
    async poll() {
      listedFiles = new Map();
      try {
        const answer = await poll();
        // The sessions whose last message may be asked for until the next poll,
        // each with the file it was listed from. A poll that could not list
        // them lists none, so none may be asked for.
        lastMessages?.keep(
          new Map<string, string | null>(
            answer.sessions.map(({ id }) => [id, listedFiles.get(id) ?? null]),
          ),
        );
        // A poll that could not list them never asks for a subagent's folder, so
        // what is kept of those goes here.
        if (answer.sessions.length === 0) subagents.forget();
        return answer;
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace. It lists no
        // session, so no last message or subagent's file name is kept either.
        lastMessages?.forget();
        subagents.forget();
        return result(
          "error",
          "Something unexpected went wrong while reading Gemini CLI sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
    async lastMessage(sessionId) {
      if (lastMessagesOff !== null) {
        return { message: null, reason: "off", setting: lastMessagesOff };
      }
      return lastMessages?.read(sessionId) ?? null;
    },
    get lastMessagesKept() {
      return lastMessages?.size ?? 0;
    },
    get subagentFoldersKept() {
      return subagents.size;
    },
  };
}
