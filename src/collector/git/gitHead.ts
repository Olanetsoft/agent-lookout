import type { GitHead } from "../../core/sessions/session.ts";
import { MAX_NAME_LENGTH, sessionName } from "../../core/text.ts";

/**
 * The three files Agent Lookout reads in a git repository, and nothing else in it:
 *
 * - `HEAD`, in the repository's git folder, which says what is checked out:
 *   `ref: refs/heads/<branch>` for a branch, or a commit's ID when no branch is.
 * - `.git` when it is a file rather than a folder, as in a worktree or a
 *   submodule: one line, `gitdir: <path>`, naming the git folder that holds the
 *   `HEAD`. A relative path is relative to the folder the file is in.
 * - `commondir`, beside that `HEAD`, which a worktree's git folder has and a
 *   submodule's does not: one line, the path of the repository's own git
 *   folder, which every worktree of it shares. A relative path is relative to
 *   the folder the file is in, and git writes `../..`.
 *
 * Each is one short line. Anything else in them is no answer: a file that says
 * something else, says it on more than one line, or is over the size limit
 * gives no branch, or no repository, and is never guessed at.
 */

/** The largest of any of the files that is read. A larger one is not read, and gives nothing. */
export const MAX_GIT_FILE_BYTES = 4 * 1024;

/**
 * The longest branch kept, in characters. A branch is made fit to show as a
 * status file's session name is: cleaned of control characters and of those
 * that make text run the other way, which git allows in a branch name and which
 * can make one name read as another, and cut to this length.
 */
export const MAX_BRANCH_LENGTH = MAX_NAME_LENGTH;

/** How many characters of a commit's ID are shown, as git shows it in short. */
export const SHORT_COMMIT_LENGTH = 7;

/** A commit's whole ID in lower-case hexadecimal: 40 characters, or 64 in a SHA-256 repository. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Where `HEAD` names the branch checked out. */
const BRANCH_REF = "refs/heads/";

/** The file's one line, without the line break git ends it with, or null when it has more. */
function oneLine(content: string): string | null {
  const line = content.replace(/\r?\n$/, "");
  return /[\r\n]/.test(line) ? null : line;
}

/**
 * What a `HEAD` file says is checked out: the branch, or the short ID of the
 * commit when no branch is. Null for anything else, such as a reference
 * outside `refs/heads/`, an ID that is not one, or text that is not git's.
 */
export function parseHead(content: string): GitHead | null {
  const line = oneLine(content);
  if (line === null) return null;
  if (line.startsWith("ref:")) {
    const ref = line.slice("ref:".length).trim();
    if (!ref.startsWith(BRANCH_REF)) return null;
    const branch = sessionName(ref.slice(BRANCH_REF.length));
    return branch === undefined ? null : { branch };
  }
  const id = line.trim();
  return COMMIT_ID.test(id) ? { commit: id.slice(0, SHORT_COMMIT_LENGTH) } : null;
}

/** A path as a file wrote it, or null when it is empty or is no path git wrote. */
function pathIn(text: string): string | null {
  const target = text.trim();
  // A path with a control character in it is no path git wrote.
  return target === "" || /\p{Cc}/u.test(target) ? null : target;
}

/**
 * The path a `.git` file names, as written, or null when the file is not one.
 * The caller resolves a relative path against the folder the file is in.
 */
export function parseGitFile(content: string): string | null {
  const line = oneLine(content);
  if (line === null || !line.startsWith("gitdir:")) return null;
  return pathIn(line.slice("gitdir:".length));
}

/**
 * The path a `commondir` file names, as written, or null when the file is not
 * one. The caller resolves a relative path against the folder the file is in.
 */
export function parseCommonDir(content: string): string | null {
  const line = oneLine(content);
  return line === null ? null : pathIn(line);
}
