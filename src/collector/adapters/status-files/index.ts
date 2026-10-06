import os from "node:os";
import path from "node:path";

import { mapStatusFileStatus } from "../../../core/mapping/statusFileMapping.ts";
import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type {
  Session,
  SessionStatus,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type OpenFile, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import {
  isStatusFileName,
  MAX_FILE_BYTES,
  MAX_FILES,
  parseStatusFile,
  type StatusFile,
} from "./statusFile.ts";
import { SOURCE_ID, statusFileSession } from "./toSession.ts";

/** The variable that names another folder of status files. */
export const STATUS_DIR_ENV = "AGENT_LOOKOUT_STATUS_DIR";

/** The one way this adapter reads, named for the poller. */
export const BASIS = "files";

const LABEL = "Status files";

/**
 * What a session from a status file can show. The format has a word for every
 * status and a field for a name (`statusFile.ts`), so each is there when the
 * agent writes it and not otherwise. Quiet for is when the file was last
 * written, which says something only of an agent that writes it as it works.
 * Nothing in a file is used to reach a session, so there is no Jump, and
 * nothing in one is used to stop a session either.
 */
export const STATUS_FILE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": { level: "partly", reason: "If the agent writes working and idle." },
  "needs-you": { level: "partly", reason: "If the agent writes waiting." },
  finished: { level: "partly", reason: "If the agent writes finished." },
  failed: { level: "partly", reason: "If the agent writes failed." },
  names: {
    level: "partly",
    reason: "If the agent writes a name. Otherwise the folder's or the file's name is used.",
  },
  jump: { level: "no", reason: "Nothing in a status file is used to reach a session." },
  "quiet-for": { level: "partly", reason: "If the agent writes its file again as it works." },
  stop: {
    level: "no",
    reason: "Any program can write a status file, so nothing in one is used to stop a session.",
  },
};

/** Everything the adapter touches outside itself. Tests replace these. */
export interface StatusFileAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  /** How the folder is read: the same reading-only access the Codex adapter has. */
  io?: ReadOnlyIo;
  isAlive?: (pid: number) => boolean;
  /**
   * How often the poller calls `poll()`, which is how often the folder is read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   * Defaults to the poller's interval.
   */
  pollIntervalMs?: number;
}

/** What became of one file in a poll. */
type Reading =
  /** It went between the listing and the read. */
  | { kind: "gone" }
  /**
   * Not read: a link, a pipe, a folder, a file over the limit, or one that
   * cannot be opened. Why, in the words that follow the file's name.
   */
  | { kind: "refused"; why: string }
  /** Read, and not a status file. */
  | { kind: "invalid" }
  | { kind: "read"; file: StatusFile; mtimeMs: number };

/** A file as last read. */
interface Read {
  file: StatusFile;
  mtimeMs: number;
}

/** "1 file was", "3 files were": a count and its words, singular or plural. */
function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Finds the sessions of any agent that says what it is doing in a status file:
 * one small JSON file for each session, in one folder. This is how an agent
 * Agent Lookout has no adapter for appears, including one a person wrote
 * themselves, with nothing installed into it and no network.
 *
 * The folder is `~/.agent-lookout/sessions`, or the one `AGENT_LOOKOUT_STATUS_DIR`
 * names. Agent Lookout never makes it and never writes, renames or deletes
 * anything in it: the person or their agent makes it. Until then the source is
 * "not set up", which is not a problem.
 *
 * On every poll it lists the folder and reads each file whose name ends in
 * `.json` and does not start with a dot, directly in the folder. It reads at
 * most 200: when there are more, the 200 written most recently, so files left
 * behind by sessions long over are what is skipped, not a new session. It
 * reads only ordinary files of 16 KB or less, and does not follow a symbolic
 * link in the folder. Anything over a limit, and any file that is not a status
 * file, is skipped and counted, the first one by name is named, and the rest
 * are read as before. `statusFile.ts` has the format.
 *
 * - A file that names a process which has gone is a leftover from an agent that
 *   stopped without tidying up, and its session is not shown, unless it says
 *   it finished or failed: those are expected to have no process.
 * - A finished or failed session is shown for 24 hours, counted from its
 *   status time or, without one, from when its file was last written. The file
 *   says the session is over, so this holds even while its process runs, as an
 *   agent that serves many sessions from one process does.
 * - A file that was a status file a poll ago and cannot be parsed now was most
 *   likely caught half written. What it said a poll ago stands, for one poll.
 *
 * The status time is the file's `since` when it could be right. Without one, it
 * is when Agent Lookout first saw the session in that status, and it does not
 * move while the status stands. A session that was already in the folder when
 * Agent Lookout first read it has no such moment, so its time is not known
 * until its status changes.
 *
 * When the file was last written, from the open file it was read through, is
 * the session's last write.
 */
export function createStatusFileAdapter(options: StatusFileAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const isAlive = options.isAlive ?? isProcessAlive;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  const override = env[STATUS_DIR_ENV]?.trim() || undefined;
  const dir = path.resolve(override ?? path.join(homeDir, ".agent-lookout", "sessions"));
  const dirName = tildify(dir, homeDir);
  const decoder = new TextDecoder();

  /** Each file's last good reading, from the poll before, by file name. */
  let lastRead = new Map<string, Read>();
  /** Each session's status and the time it began, from the poll before, by file name. */
  let statuses = new Map<string, { status: SessionStatus; since: number | null }>();
  /**
   * Whether what the folder held was known before this poll: it was listed,
   * or found missing. Until then a session cannot be said to have just begun.
   */
  let contentsKnown = false;

  function watching(read: string, files?: { read: number; skipped: number }): SourceFact[] {
    const facts = [
      { label: "Folder", value: dirName },
      { label: "Read", value: read },
    ];
    if (files) {
      facts.push(
        { label: "Files read", value: String(files.read) },
        { label: "Files skipped", value: String(files.skipped) },
      );
    }
    return facts;
  }

  function result(
    state: SourceState,
    detail: string,
    facts: SourceFact[],
    checkedAt: number,
    sessions: Session[] = [],
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: facts,
      checkedAt,
    };
    if (state === "ok") return { health, sessions, basis: BASIS };
    // A folder that is not there has been read too, and holds no sessions. It is
    // said in the same basis, so the poller takes the sessions in a folder made
    // later to have appeared.
    if (state === "not-set-up") return { health, sessions: [], basis: BASIS };
    return { health, sessions: [] };
  }

  /** Reads one file, if it is an ordinary file within the limit. Never throws. */
  async function readOne(file: string): Promise<Reading> {
    let open: OpenFile;
    try {
      open = await io.openRegular(file);
    } catch (error) {
      if (isMissing(error)) return { kind: "gone" };
      // A link is refused by the open itself, and a pipe or a folder once it is open.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const notAFile = code === undefined || code === "ELOOP" || code === "EISDIR";
      return { kind: "refused", why: notAFile ? "is not an ordinary file" : "could not be opened" };
    }
    const tooLarge: Reading = { kind: "refused", why: "is over 16 KB" };
    try {
      // The size is checked before a byte is read.
      if (open.info.size > MAX_FILE_BYTES) return tooLarge;
      // One byte over the limit tells a file that grew after it was opened.
      const bytes = await open.read(0, MAX_FILE_BYTES + 1);
      if (bytes.byteLength > MAX_FILE_BYTES) return tooLarge;
      const parsed = parseStatusFile(decoder.decode(bytes));
      return parsed
        ? { kind: "read", file: parsed, mtimeMs: open.info.mtimeMs }
        : { kind: "invalid" };
    } catch {
      return { kind: "refused", why: "could not be read" };
    } finally {
      await open.close().catch(() => {});
    }
  }

  /**
   * The names to read, in order of name: every one, or when there are more than
   * the limit, the ones written most recently. Files that sessions long over
   * left behind are then what is skipped, and never a session that has just
   * begun. A link is not followed to find when it was written.
   */
  async function toRead(names: string[]): Promise<string[]> {
    if (names.length <= MAX_FILES) return names;
    const written = await Promise.all(
      names.map(async (name) => {
        const info = await io.lstat(path.join(dir, name)).catch(() => null);
        // One that went since the listing is the last to be read.
        return { name, mtimeMs: info?.mtimeMs ?? -Infinity };
      }),
    );
    written.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
    return written
      .slice(0, MAX_FILES)
      .map((entry) => entry.name)
      .sort();
  }

  /** When a session's status began, as far as can be told. See the adapter's comment. */
  function statusSince(
    fileName: string,
    file: StatusFile,
    status: SessionStatus,
    at: number,
  ): number | null {
    const given = plausibleTime(file.since, at);
    if (given !== null) return given;
    const before = statuses.get(fileName);
    if (before?.status === status) return before.since;
    return contentsKnown ? at : null;
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    let names: string[];
    try {
      names = await io.readdir(dir);
    } catch (error) {
      if (!isMissing(error)) {
        const answer = result(
          "error",
          `Status files could not be read: the folder ${dirName} could not be listed.`,
          watching("cannot be read"),
          checkedAt,
        );
        answer.health.advice = "Check that your user account can open the folder.";
        return answer;
      }
      // Known to hold nothing: whatever appears in it from now on is new.
      contentsKnown = true;
      lastRead = new Map();
      statuses = new Map();
      return result(
        "not-set-up",
        `To show any other agent here, make the folder ${dirName} and have the agent write a small JSON file in it for each session, as "Your own agents" in docs/GUIDE.md describes.`,
        watching("not found"),
        checkedAt,
      );
    }

    const listed = names.filter(isStatusFileName).sort();
    let skipped = Math.max(0, listed.length - MAX_FILES);
    let read = 0;
    let ended = 0;
    let old = 0;
    /** The first file skipped, by name, and why, so the person knows where to look. */
    let firstSkipped: { name: string; why: string } | undefined;
    const sessions: Session[] = [];
    const nextRead = new Map<string, Read>();
    const nextStatuses = new Map<string, { status: SessionStatus; since: number | null }>();

    for (const fileName of await toRead(listed)) {
      const reading = await readOne(path.join(dir, fileName));
      let kept: Read | undefined;
      if (reading.kind === "read") {
        kept = reading;
        nextRead.set(fileName, kept);
      } else if (reading.kind === "invalid") {
        // Kept only from the poll before, so it stands for one poll and no more.
        kept = lastRead.get(fileName);
      }
      if (kept === undefined) {
        if (reading.kind === "gone") continue;
        skipped += 1;
        firstSkipped ??= {
          // A file's name is as untrusted as what it holds.
          name: sessionName(fileName) ?? "a file",
          why: reading.kind === "refused" ? reading.why : "is not JSON with an agent and a status",
        };
        continue;
      }
      read += 1;

      const { file, mtimeMs } = kept;
      const { status } = mapStatusFileStatus(file);
      // The file says the session is over, whether or not its process still runs.
      const over = status === "finished" || status === "failed";
      const alive = file.pid === undefined ? undefined : isAlive(file.pid);
      if (alive === false && !over) {
        ended += 1;
        continue;
      }

      const since = statusSince(fileName, file, status, checkedAt);
      nextStatuses.set(fileName, { status, since });
      const session = statusFileSession({
        fileName,
        file,
        statusSince: since,
        alive,
        writtenAt: mtimeMs,
        now: checkedAt,
      });
      if (over && !isWithinRetention(since ?? mtimeMs, checkedAt)) {
        old += 1;
        continue;
      }
      sessions.push(session);
    }

    lastRead = nextRead;
    statuses = nextStatuses;
    contentsKnown = true;

    let detail = `Each file ending in .json in ${dirName} is one session, written by the agent it belongs to.`;
    if (ended > 0) {
      detail += ` ${counted(ended, "file names", "files name")} a process that has ended, so ${ended === 1 ? "its session is" : "their sessions are"} not shown.`;
    }
    if (old > 0) {
      detail += ` ${counted(old, "finished or failed session", "finished or failed sessions")} ended more than a day ago and ${old === 1 ? "is" : "are"} not shown.`;
    }
    if (skipped > 0) {
      const named = firstSkipped
        ? `${skipped === 1 ? ":" : ", among them"} ${firstSkipped.name}, which ${firstSkipped.why}`
        : "";
      detail += ` ${counted(skipped, "file was", "files were")} skipped${named}. A status file is an ordinary file of 16 KB or less that holds a JSON object with an agent and a status, and only the ${MAX_FILES} written most recently are read.`;
    }
    return result(
      "ok",
      detail,
      watching(every(pollIntervalMs), { read, skipped }),
      checkedAt,
      sessions,
    );
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: STATUS_FILE_CAPABILITIES,
    lookingIn: `Looking for status files in ${dirName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading status files.",
          watching(every(pollIntervalMs)),
          now(),
        );
      }
    },
  };
}
