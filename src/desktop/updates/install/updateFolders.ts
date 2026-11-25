// The folders a downloaded version waits in, and is installed from: one for
// each download, in the app's own folder of user data, which macOS never
// clears. 0.2.31 and earlier made theirs in the system's temporary folder,
// where macOS clears files nothing has read for three days and leaves their
// folders.
//
// After an install, the old app is in one of them, so it is there until the
// new one has run. What an earlier run of the app left, in either place, is
// swept once this one runs, and only while the app in its place is this
// version.
//
// In Electron, Node's own file functions read an `.asar` as a folder, and keep
// it open, so they cannot remove one: they leave a discarded app's `app.asar`
// behind. What removes is handed in, and `main.ts` hands in Electron's
// `original-fs`, which takes an `.asar` for the file it is.

import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** What the name of each of them begins with, in this version and every earlier one. */
export const UPDATE_FOLDER_PREFIX = "agent-lookout-update-";

/** What removes a folder with all that is in it: `original-fs`'s in the app. */
export interface Removal {
  rm(folder: string, options: { recursive: true; force: true }): Promise<void>;
  rmSync(folder: string, options: { recursive: true; force: true }): void;
}

export interface UpdateFoldersOptions {
  /** Where they are made: the app's own folder of user data. */
  dataDir: string;
  /** Where 0.2.31 and earlier made theirs: the system's temporary folder. */
  tempDir: string;
  removal: Removal;
}

export interface UpdateFolders {
  /** Makes one, and gives its path. Throws when it cannot be made. */
  make(): string;
  /** Removes one, or a folder in one. One that could not be removed is tried again by `removeAll`. */
  remove(folder: string): Promise<void>;
  /** Removes each one made here, at once, but the one given, as the app quits. */
  removeAll(but: string | null): void;
  /** Removes each one that was not made here: what an earlier run left. */
  sweep(): Promise<void>;
}

export function createUpdateFolders({
  dataDir,
  tempDir,
  removal,
}: UpdateFoldersOptions): UpdateFolders {
  /** Those made here that are still there. */
  const made = new Set<string>();

  const remove = async (folder: string): Promise<void> => {
    try {
      await removal.rm(folder, { recursive: true, force: true });
      made.delete(folder);
    } catch {
      // Tried again as the app quits, and swept when it next runs.
    }
  };

  return {
    make() {
      // In one step, so a sweep never takes one that has just been made for another run's.
      const folder = mkdtempSync(path.join(dataDir, UPDATE_FOLDER_PREFIX));
      made.add(folder);
      return folder;
    },
    remove,
    removeAll(but) {
      for (const folder of made) {
        if (folder === but) continue;
        try {
          removal.rmSync(folder, { recursive: true, force: true });
          made.delete(folder);
        } catch {
          // Swept when the app next runs.
        }
      }
    },
    async sweep() {
      for (const dir of [dataDir, tempDir]) {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const folder = path.join(dir, entry.name);
          const ours = entry.isDirectory() && entry.name.startsWith(UPDATE_FOLDER_PREFIX);
          if (ours && !made.has(folder)) await remove(folder);
        }
      }
    },
  };
}
