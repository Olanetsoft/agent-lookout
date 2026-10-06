import os from "node:os";
import path from "node:path";

import type { GitHead, Session } from "../../core/sessions/session.ts";
import { isMissing, nodeIo, type ReadOnlyIo, type FileInfo } from "../files/readOnlyIo.ts";
import { MAX_GIT_FILE_BYTES, parseCommonDir, parseGitFile, parseHead } from "./gitHead.ts";
import { repositoryOf } from "./repository.ts";

/** How long what was read for a folder stands before its `HEAD` is read again. */
export const BRANCH_READ_MS = 10_000;

/** The most folders looked in for `.git`, from a session's folder up. */
export const MAX_LEVELS = 24;

/**
 * How long a poll waits for the reads it starts. Reading three small files takes
 * far less. Past it, as on a network drive that has gone away, the poll goes on
 * with what was read before, and the reads' answers are used once they arrive.
 */
export const READ_WAIT_MS = 1_000;

/**
 * What the finder does to the file system: the reading-only access the Codex
 * adapter has, less listing a folder. It never writes, and never runs git.
 */
export type GitIo = Pick<ReadOnlyIo, "stat" | "lstat" | "openRegular">;

interface Where {
  io: GitIo;
  homeDir: string;
}

/** Errors in what is read stop the read, so junk is never shown as a branch. */
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * One small file's text: an ordinary file, never a link, a pipe or a folder, of
 * no more than `maxBytes` of UTF-8, `MAX_GIT_FILE_BYTES` unless said. Undefined
 * when there is nothing at all by that name, and null for anything else.
 */
export async function readGitFile(
  io: Pick<GitIo, "openRegular">,
  file: string,
  maxBytes: number = MAX_GIT_FILE_BYTES,
): Promise<string | null | undefined> {
  let open;
  try {
    open = await io.openRegular(file);
  } catch (error) {
    return isMissing(error) ? undefined : null;
  }
  try {
    // The size is checked before a byte is read, and one byte over the limit
    // tells a file that grew after it was opened.
    if (open.info.size > maxBytes) return null;
    const bytes = await open.read(0, maxBytes + 1);
    if (bytes.byteLength > maxBytes) return null;
    return decoder.decode(bytes);
  } catch {
    return null;
  } finally {
    await open.close().catch(() => {});
  }
}

/**
 * The repository's own git folder, for the git folder a `.git` file names:
 * what its `commondir` names, resolved against it, as a worktree's does. Null
 * when it has no `commondir`, as a submodule's has not, and undefined when it
 * has one that cannot be read, which says no repository.
 */
async function commonDirOf(io: GitIo, gitDir: string): Promise<string | null | undefined> {
  const content = await readGitFile(io, path.join(gitDir, "commondir"));
  if (content === undefined) return null;
  const target = content === null ? null : parseCommonDir(content);
  return target === null ? undefined : path.resolve(gitDir, target);
}

/** What is checked out in a folder, and the repository's own git folder, which never leaves the collector. */
interface FoundHead {
  head: GitHead;
  /**
   * The repository's own git folder, which its worktrees share: a `.git`
   * folder, what a worktree's `commondir` names, or the folder any other
   * `.git` file names. Null when the repository could not be told.
   */
  gitFolder: string | null;
}

/**
 * What the `.git` found in `dir` says is checked out, and which repository it
 * is. A folder holds `HEAD` itself. A file names the folder that does, as a
 * worktree's or a submodule's does, and that folder's `commondir`, when it has
 * one, names the repository's own. Anything else, such as a link, gives
 * nothing. `repository.ts` works out the repository from those paths.
 */
async function headIn(dir: string, kind: FileInfo["kind"], io: GitIo): Promise<FoundHead | null> {
  const marker = path.join(dir, ".git");
  let gitDir: string;
  if (kind === "directory") {
    gitDir = marker;
  } else if (kind === "file") {
    const content = await readGitFile(io, marker);
    const target = typeof content === "string" ? parseGitFile(content) : null;
    if (target === null) return null;
    gitDir = path.resolve(dir, target);
  } else {
    return null;
  }
  const content = await readGitFile(io, path.join(gitDir, "HEAD"));
  const head = typeof content === "string" ? parseHead(content) : null;
  if (head === null) return null;
  // Only a git folder a `.git` file names can be a worktree's.
  const commonDir = kind === "file" ? await commonDirOf(io, gitDir) : null;
  const repository = commonDir === undefined ? null : repositoryOf({ dir, gitDir, commonDir });
  if (repository === null) return { head, gitFolder: null };
  return { head: { ...head, repository }, gitFolder: commonDir ?? gitDir };
}

/**
 * The branch or commit checked out in the git repository a folder is in, with
 * the repository, or null when it is in none that can be read. Never rejects.
 *
 * From the folder up, it looks for `.git` in each folder in turn, without
 * following a link, and the nearest wins, as it does for git. It never looks in
 * the home folder or the root, nor above them, nor more than `MAX_LEVELS`
 * folders up. A folder that does not exist is in no repository. It reads only
 * `.git` when that is a file, `HEAD`, and beside a `HEAD` that a `.git` file
 * leads to, `commondir`: `gitHead.ts` has what each holds.
 */
export async function findGitHead(cwd: string, where: Where): Promise<GitHead | null> {
  return (await findHead(cwd, where))?.head ?? null;
}

/** What `findGitHead` gives, with the repository's own git folder. Never rejects. */
async function findHead(cwd: string, { io, homeDir }: Where): Promise<FoundHead | null> {
  if (!path.isAbsolute(cwd)) return null;
  const home = path.resolve(homeDir);
  let dir = path.resolve(cwd);
  try {
    if ((await io.stat(dir)).kind !== "directory") return null;
  } catch {
    return null;
  }
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const parent = path.dirname(dir);
    if (dir === home || dir === parent) return null;
    let kind: FileInfo["kind"];
    try {
      kind = (await io.lstat(path.join(dir, ".git"))).kind;
    } catch (error) {
      if (!isMissing(error)) return null;
      dir = parent;
      continue;
    }
    // Whatever the nearest `.git` is, it is the one git would use, so the walk
    // ends here, and a repository further up is never shown in its place.
    return headIn(dir, kind, io).catch(() => null);
  }
  return null;
}

export interface BranchFinderOptions {
  io?: GitIo;
  homeDir?: string;
  now?: () => number;
  /** Defaults to `READ_WAIT_MS`. */
  waitMs?: number;
}

export interface BranchFinder {
  /**
   * The sessions, each one whose folder is in a git repository with `git` set
   * to what is checked out there. Never rejects, and answers within the wait.
   */
  annotate(sessions: readonly Session[]): Promise<Session[]>;
  /**
   * The repository's own git folder for a session's folder, as last read, or
   * null when the folder is in no repository that could be told. It stays in
   * the collector: the pull request finder reads the remote there, and no
   * session carries it.
   */
  gitFolderOf(cwd: string): string | null;
}

/** What is known of one folder. */
interface Known {
  found: FoundHead | null;
  /** When it was last read. */
  readAt: number;
}

/** Resolves when the work is done, or after `ms`, whichever is first. */
function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A wait alone should not keep a process alive.
    timer.unref?.();
    void work.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Gives every session, whatever its source, the branch of the folder it works
 * in. The poller calls it with each poll's sessions.
 *
 * It keeps what it read for each session's folder for `BRANCH_READ_MS`, so a
 * folder's `HEAD` is read at most once in 10 seconds however many sessions work
 * in that folder, and a branch that is switched shows within about that.
 * Sessions in different folders of one repository each read it. A folder no
 * session is in any more is forgotten.
 *
 * The folders are read one after another, and no read starts while the last
 * has not answered. A read that hangs, as on a network drive that has gone
 * away, then holds one of the few threads Node reads files with, never all of
 * them, and the collector's other reads go on.
 */
export function createBranchFinder(options: BranchFinderOptions = {}): BranchFinder {
  const where: Where = { io: options.io ?? nodeIo, homeDir: options.homeDir ?? os.homedir() };
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? READ_WAIT_MS;
  const known = new Map<string, Known>();
  /** The reads under way, if there are any. */
  let running: Promise<void> | null = null;

  async function readAll(folders: readonly string[]): Promise<void> {
    for (const folder of folders) {
      const found = await findHead(folder, where).catch(() => null);
      known.set(folder, { found, readAt: now() });
    }
  }

  return {
    async annotate(sessions) {
      const folders = new Set<string>();
      for (const session of sessions) if (session.cwd) folders.add(session.cwd);
      for (const folder of known.keys()) if (!folders.has(folder)) known.delete(folder);

      // Reads a poll before have not answered: none is started, and they are
      // not waited for again, so a stuck one slows no poll after the first.
      if (!running) {
        const at = now();
        const due = [...folders].filter(
          (folder) => at - (known.get(folder)?.readAt ?? -Infinity) >= BRANCH_READ_MS,
        );
        if (due.length > 0) {
          const reads = readAll(due).finally(() => {
            running = null;
          });
          running = reads;
          await within(reads, waitMs);
        }
      }

      return sessions.map((session) => {
        const head = session.cwd ? known.get(session.cwd)?.found?.head : null;
        return head ? { ...session, git: head } : session;
      });
    },

    gitFolderOf: (cwd) => known.get(cwd)?.found?.gitFolder ?? null,
  };
}
