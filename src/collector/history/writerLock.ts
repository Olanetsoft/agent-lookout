import { randomBytes } from "node:crypto";

import { isProcessAlive, validPid } from "../processes/pids.ts";
import type { HistoryFs, PathInfo } from "./historyFiles.ts";

/** The lock's name in the history folder. It is not a history file. */
export const LOCK_FILE = "writer.lock";

/**
 * How long a lock goes unrefreshed before it counts as left behind. The copy
 * that holds it refreshes it every few seconds, so a lock this old belongs to
 * a copy that has stopped, or to a process id the system has since given to
 * another program.
 */
export const LOCK_STALE_MS = 30_000;

/** The most a lock file holds: one small line. */
const MAX_LOCK_BYTES = 256;

/** The longest mark or fingerprint a lock is read with. Its own are 16 and 32 characters. */
const MAX_MARK_LENGTH = 64;

export interface WriterLockOptions {
  fs: HistoryFs;
  /** The lock's path. */
  file: string;
  /** This process. Defaults to `process.pid`. */
  pid?: number;
  now?: () => number;
  /** Defaults to asking the system with signal 0. */
  isAlive?: (pid: number) => boolean;
  staleAfterMs?: number;
  /**
   * What tells this lock from another in the same process, such as the one a
   * dev server's reload leaves running for a moment. Defaults to a random one.
   */
  token?: string;
  /**
   * Which sources this copy watches, as a fingerprint of their folders, so a
   * copy can tell that the one writing watches others. Null when not known.
   */
  sources?: string | null;
}

/**
 * Which copy of Agent Lookout writes the history. More than one can run at
 * once, such as the Mac app and `npm run dev`, and each sees the same sessions,
 * so two writing would put every change in the files twice. The one that holds
 * the lock writes. The others read what was kept when they started and keep
 * the rest in memory, and one of them takes over once the writer stops.
 *
 * The lock is a file that names the process holding it, with a mark of the
 * lock's own, so that two in one process are told apart, and a fingerprint of
 * the folders it reads sessions from. It counts as held while that process
 * runs and the file has been refreshed in the last 30 seconds, so a lock left
 * behind by a copy that crashed, or by a process before a restart of the
 * computer, is taken over. Only the lock that made the file refreshes or
 * deletes it.
 */
export interface WriterLock {
  /** Takes the lock when nobody holds it. Says whether this copy holds it now. */
  take(): Promise<boolean>;
  /** The same at once, as Agent Lookout starts writing, so it knows from the start whether it writes. */
  takeNow(): boolean;
  /**
   * While it is held: checks that the file is still this lock's own, and
   * marks it fresh. Says whether this copy still holds it. A lock that has
   * gone, or is another's, is held no more, and is taken again with `take`.
   */
  keep(): Promise<boolean>;
  /** Whether the file is still this lock's own, checked at once: before the last write as Agent Lookout stops. */
  stillHeldNow(): boolean;
  /** Lets it go, at once, as Agent Lookout stops. A file that is another's by now is left alone. */
  releaseNow(): void;
  readonly held: boolean;
  /**
   * Set when the last try to take the lock found it held by a copy that
   * watches other folders: its history is not this copy's.
   */
  readonly heldByOtherSources: boolean;
}

/** What a lock someone made says, as far as taking it goes. */
type Verdict = "take-over" | "leave";

/** Whom a lock's text names. */
interface Holder {
  pid: number;
  token: string | null;
  sources: string | null;
}

function mark(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= MAX_MARK_LENGTH
    ? value
    : null;
}

/** Whom a lock's text names, or null when it names nobody that could be a process. */
function holderIn(text: string): Holder | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const fields = value as { pid?: unknown; token?: unknown; sources?: unknown };
    const pid = validPid(fields.pid);
    if (pid === undefined) return null;
    return { pid, token: mark(fields.token), sources: mark(fields.sources) };
  } catch {
    return null;
  }
}

export function createWriterLock(options: WriterLockOptions): WriterLock {
  const { fs, file } = options;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? isProcessAlive;
  const staleAfterMs = options.staleAfterMs ?? LOCK_STALE_MS;
  const token = options.token ?? randomBytes(8).toString("hex");
  const sources = options.sources ?? null;
  const content = `${JSON.stringify({ pid, token, ...(sources !== null && { sources }) })}\n`;
  let held = false;
  let heldByOtherSources = false;

  const isOwn = (holder: Holder | null) => holder?.pid === pid && holder.token === token;

  /**
   * Whether a lock that is there may be taken over. Something that is not a
   * file of ours is left alone, and nobody writes. A fresh lock that names
   * nobody may be one another copy is writing this moment, and is taken only
   * once it has gone stale. So is one of another lock in this process. One
   * left behind, or this lock's own, is taken over.
   */
  function verdict(info: PathInfo, holder: Holder | null): Verdict {
    heldByOtherSources = false;
    if (info.kind !== "file") return "leave";
    const fresh = now() - info.mtimeMs < staleAfterMs;
    if (!fresh || isOwn(holder)) return "take-over";
    if (holder === null) return "leave";
    if (holder.pid === pid || isAlive(holder.pid)) {
      heldByOtherSources =
        sources !== null && holder.sources !== null && holder.sources !== sources;
      return "leave";
    }
    return "take-over";
  }

  async function make(): Promise<boolean> {
    try {
      await fs.create(file, content);
      held = true;
      heldByOtherSources = false;
      return true;
    } catch {
      return false;
    }
  }

  function makeNow(): boolean {
    try {
      fs.createNow(file, content);
      held = true;
      heldByOtherSources = false;
      return true;
    } catch {
      return false;
    }
  }

  async function holder(): Promise<Holder | null> {
    try {
      return holderIn(await fs.readRegular(file, MAX_LOCK_BYTES));
    } catch {
      return null;
    }
  }

  function holderNow(): Holder | null {
    try {
      return holderIn(fs.readRegularNow(file, MAX_LOCK_BYTES));
    } catch {
      return null;
    }
  }

  return {
    async take() {
      if (await make()) return true;
      let info: PathInfo;
      try {
        info = await fs.lstat(file);
      } catch {
        // Gone in between: another copy let it go.
        return make();
      }
      if (verdict(info, await holder()) === "leave") return false;
      try {
        await fs.remove(file);
      } catch {
        return false;
      }
      // Should another copy take it over at the same moment, the two locks
      // see whose file is there at their next `keep`, and only that one goes on.
      return make();
    },
    takeNow() {
      if (makeNow()) return true;
      let info: PathInfo;
      try {
        info = fs.lstatNow(file);
      } catch {
        return makeNow();
      }
      if (verdict(info, holderNow()) === "leave") return false;
      try {
        fs.removeNow(file);
      } catch {
        return false;
      }
      return makeNow();
    },
    async keep() {
      if (!held) return false;
      if (!isOwn(await holder())) {
        held = false;
        return false;
      }
      try {
        await fs.touch(file, now());
      } catch {
        // Marked fresh at the next beat instead.
      }
      return true;
    },
    stillHeldNow() {
      if (!held) return false;
      if (isOwn(holderNow())) return true;
      held = false;
      return false;
    },
    releaseNow() {
      if (!held) return;
      held = false;
      // Another copy may have taken it over since this one last looked.
      if (!isOwn(holderNow())) return;
      try {
        fs.removeNow(file);
      } catch {
        // Left behind, to be taken over once it is stale.
      }
    },
    get held() {
      return held;
    },
    get heldByOtherSources() {
      return heldByOtherSources;
    },
  };
}
