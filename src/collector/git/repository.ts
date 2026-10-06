import { createHash } from "node:crypto";
import path from "node:path";

import type { GitRepository } from "../../core/sessions/session.ts";
import { sessionName } from "../../core/text.ts";

/**
 * Which repository a session's folder belongs to, worked out from where its
 * `.git` was found, the git folder a `.git` file names, and that git folder's
 * `commondir` file. The branch finder reads them; nothing more is read here.
 *
 * A repository is its own git folder, which git calls the common dir, and
 * which every worktree of it shares:
 *
 * - A `.git` folder is the repository's own.
 * - A worktree's git folder, `<common>/worktrees/<name>`, has a `commondir`
 *   file that names the common dir. It is read rather than worked out from
 *   the path, since the common dir is `<repository>/.git` only for an ordinary
 *   clone: it is `storefront/.bare` when worktrees sit beside a bare
 *   repository, a folder anywhere for one made with `--separate-git-dir`, and
 *   `<repository>/.git/modules/<name>` for a submodule's worktrees.
 * - Any other `.git` file names the repository's own git folder, as a
 *   submodule's and a separate git folder's main working folder's do. A
 *   submodule is a repository of its own.
 */

/** How many hexadecimal characters of the hash a repository's id keeps: 64 bits. */
export const REPOSITORY_ID_LENGTH = 16;

/** Where a `.git` found in `dir` leads. */
export interface GitFolders {
  /** The folder the `.git` is in. */
  dir: string;
  /** The git folder that holds `HEAD`: the `.git` folder, or the one a `.git` file names, resolved. */
  gitDir: string;
  /**
   * What that git folder's `commondir` names, resolved: the repository's own
   * git folder, for a worktree. Null when there is none, as for a `.git`
   * folder, a submodule, or a repository's main working folder.
   */
  commonDir: string | null;
}

/**
 * A stable id for a repository's git folder: the first `REPOSITORY_ID_LENGTH`
 * characters of the SHA-256 of its path. The same folder always has the same
 * id, and the id does not hold the path.
 */
export function repositoryId(gitFolder: string): string {
  return createHash("sha256").update(gitFolder).digest("hex").slice(0, REPOSITORY_ID_LENGTH);
}

/**
 * The name of the repository whose own git folder is `common`, from that path
 * alone, for a worktree: the folder that holds it when it is hidden, as `.git`
 * and `.bare` are, and otherwise its own name without a `.git` at its end, as
 * for `storefront.git`.
 */
function sharedName(common: string): string {
  const base = path.basename(common);
  if (base.startsWith(".")) return path.basename(path.dirname(common));
  return base.endsWith(".git") ? base.slice(0, -".git".length) : base;
}

/**
 * The repository a `.git` belongs to: its name, cleaned and cut as a session's
 * name is, and its id, the same for its main working folder and every worktree
 * of it. The name is the main working folder's, `dir`'s, where the `.git` is
 * that folder's own, and is worked out from the shared git folder for a
 * worktree. Null when there is no name to give, as at the root.
 */
export function repositoryOf({ dir, gitDir, commonDir }: GitFolders): GitRepository | null {
  const name = sessionName(commonDir === null ? path.basename(dir) : sharedName(commonDir));
  return name === undefined ? null : { id: repositoryId(commonDir ?? gitDir), name };
}
