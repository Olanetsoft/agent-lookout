import path from "node:path";

import type { ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Whether the Antigravity IDE's folder, or Antigravity 2.0's, is beside the
 * Antigravity CLI's, so the Sources card can say it is there and that Agent
 * Lookout does not read it yet.
 *
 * Google's hooks documentation (https://antigravity.google/docs/hooks) gives
 * each product an app data folder of its own under `~/.gemini`:
 * `antigravity-cli` for the CLI, `antigravity-ide` for the IDE, and
 * `antigravity` for Antigravity 2.0, the desktop app that holds the Agent
 * Manager, which a 1.x Antigravity IDE used too. A folder can be there and hold
 * nothing, so the card says only that it is there.
 *
 * Each is looked at with one `lstat`, which does not follow a link, so a link
 * in its place counts as there. Nothing in either is opened, listed or
 * watched, and nothing is kept but whether each is there. They are looked at
 * on the first poll, then at most once a minute.
 */

/** The Antigravity IDE's folder, beside the CLI's. */
export const IDE_FOLDER = "antigravity-ide";

/** Antigravity 2.0's folder, beside the CLI's, which an older Antigravity IDE used too. */
export const APP_FOLDER = "antigravity";

/** Each folder as the card names it, such as `~/.gemini/antigravity-ide`, or null when it is not there. */
export interface OtherFolders {
  ide: string | null;
  app: string | null;
}

/** What the card adds about the two folders, or null when neither is there. */
export function otherFoldersNote({ ide, app }: OtherFolders): string | null {
  if (ide !== null && app !== null) {
    return `The Antigravity IDE's folder is here, ${ide}, and so is one of Antigravity 2.0, or of an older Antigravity IDE, ${app}. Agent Lookout reads only the Antigravity CLI so far, not either of them.`;
  }
  if (ide !== null) {
    return `The Antigravity IDE's folder is here, ${ide}. Agent Lookout reads only the Antigravity CLI so far, not the IDE.`;
  }
  if (app !== null) {
    return `A folder of Antigravity 2.0, or of an older Antigravity IDE, is here, ${app}. Agent Lookout does not read it yet.`;
  }
  return null;
}

export interface OtherFolderCheckOptions {
  /** The Antigravity CLI's folder the adapter reads. The other two are looked for beside it. */
  home: string;
  /** How a folder is named on the card. */
  name: (target: string) => string;
  io: ReadOnlyIo;
  /** How long an answer stands before the folders are looked at again. */
  recheckMs: number;
  /** On macOS and Windows a folder's name ignores case, so `Antigravity` is `antigravity`. */
  platform: NodeJS.Platform;
}

/**
 * Looks beside the CLI's folder the adapter reads, and nowhere else: beside
 * `~/.gemini/antigravity-cli` by default, and beside the folder
 * `AGENT_LOOKOUT_ANTIGRAVITY_HOME` names when it is set, so a test that names
 * a temporary folder never has the real `~/.gemini` looked in.
 */
export function createOtherFolderCheck(options: OtherFolderCheckOptions) {
  const { io, recheckMs } = options;
  const home = path.resolve(options.home);
  const ignoresCase = options.platform === "darwin" || options.platform === "win32";
  // The folder the adapter reads as the CLI's is never taken for one of these.
  const beside = (name: string) => {
    const target = path.join(path.dirname(home), name);
    const same = ignoresCase ? target.toLowerCase() === home.toLowerCase() : target === home;
    return same ? null : target;
  };
  const ide = beside(IDE_FOLDER);
  const app = beside(APP_FOLDER);

  let ideThere = false;
  let appThere = false;
  /** When the folders were last looked at. Null before the first look. */
  let checkedAt: number | null = null;

  /**
   * Whether something is at the path: a folder, or a link or anything else that
   * is not an ordinary file. A path that cannot be looked at is not said to be there.
   */
  async function isThere(target: string | null): Promise<boolean> {
    if (target === null) return false;
    try {
      return (await io.lstat(target)).kind !== "file";
    } catch {
      return false;
    }
  }

  return {
    /**
     * The note, from a fresh look once `recheckMs` has passed since the last,
     * else from the last look. A clock set back counts as time enough.
     */
    async note(at: number): Promise<string | null> {
      const since = checkedAt === null ? Infinity : at - checkedAt;
      if (since < 0 || since >= recheckMs) {
        ideThere = await isThere(ide);
        appThere = await isThere(app);
        checkedAt = at;
      }
      return otherFoldersNote({
        ide: ideThere && ide !== null ? options.name(ide) : null,
        app: appThere && app !== null ? options.name(app) : null,
      });
    },
  };
}
