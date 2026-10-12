import path from "node:path";

import { sameFolderOnDisk } from "../../../files/paths.ts";
import type { ReadOnlyIo } from "../../../files/readOnlyIo.ts";

/**
 * Whether the Antigravity IDE's folder is beside the Antigravity CLI's, so the
 * Sources card can say it is there and that Agent Lookout does not read it yet.
 *
 * Google's hooks documentation (https://antigravity.google/docs/hooks) gives
 * each product an app data folder of its own under `~/.gemini`:
 * `antigravity-cli` for the CLI, `antigravity-ide` for the IDE, and
 * `antigravity` for Antigravity 2.0, the desktop app with the Agent Manager,
 * which has a source of its own (`../app/index.ts`). A folder can be there and
 * hold nothing, so the card says only that it is there.
 *
 * The IDE's folder is looked at with one `lstat`, which does not follow a
 * link, so a link in its place counts as there. Nothing in it is opened,
 * listed or watched, and nothing is kept but whether it is there. It is looked
 * at on the first poll, then at most once a minute.
 */

/** The Antigravity IDE's folder, beside the CLI's. */
export const IDE_FOLDER = "antigravity-ide";

/** What the card adds about the IDE's folder, named as the card names it, or null when it is not there. */
export function otherFoldersNote(ide: string | null): string | null {
  return ide === null
    ? null
    : `The Antigravity IDE's folder is here, ${ide}. Agent Lookout does not read the IDE yet.`;
}

export interface OtherFolderCheckOptions {
  /** The Antigravity CLI's folder the adapter reads. The IDE's is looked for beside it. */
  home: string;
  /** How a folder is named on the card. */
  name: (target: string) => string;
  io: ReadOnlyIo;
  /** How long an answer stands before the folder is looked at again. */
  recheckMs: number;
  /** On macOS and Windows a folder's name ignores case, so `Antigravity-IDE` is `antigravity-ide`. */
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
  // The folder the adapter reads as the CLI's is never taken for the IDE's.
  const ide = path.join(path.dirname(home), IDE_FOLDER);

  let ideThere = false;
  /** When the folder was last looked at. Null before the first look. */
  let checkedAt: number | null = null;

  /**
   * Whether something is at the path: a folder, or a link or anything else that
   * is not an ordinary file. A path that cannot be looked at is not said to be there.
   */
  async function isThere(folder: string): Promise<boolean> {
    try {
      return (await io.lstat(folder)).kind !== "file";
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
        ideThere =
          !(await sameFolderOnDisk(ide, home, options.platform, io)) && (await isThere(ide));
        checkedAt = at;
      }
      return otherFoldersNote(ideThere ? options.name(ide) : null);
    },
  };
}
