import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { SWEEP_MS } from "../pi/sessionFiles.ts";

/**
 * Listing one of the folders Prime Agent keeps beside its sessions,
 * `session-leases/` or `daemon-workers/`, without following a link.
 *
 * The folder is looked up with one `lstat` on each poll, and listed again only
 * when its modified time moves, as it does when Prime Agent adds, renames or
 * removes something in it, and once a minute. A link at its name is not
 * followed: it would lead out of Prime Agent's folder, so it counts as a
 * folder that cannot be listed. Nothing in it is opened here.
 *
 * A caller may also say which folders it reads at all, from the folder's
 * `lstat`: the Autohand Code adapter reads only one that belongs to the user
 * it runs as. One it does not accept counts as a folder that cannot be listed.
 */

/** What a folder holds: its names, or why there are none. */
export type FolderListing =
  | { state: "listed"; names: readonly string[] }
  /** Nothing is at its name. */
  | { state: "missing" }
  /** It could not be looked up or listed, or a link or something other than a folder is at its name. */
  | { state: "unlistable" };

export interface FolderLister {
  /** What the folder holds now, listed again only when it is due. Never rejects. */
  list(now: number): Promise<FolderListing>;
}

export function createFolderLister(
  dir: string,
  io: ReadOnlyIo,
  sweepMs = SWEEP_MS,
  accept: (info: FileInfo) => boolean = () => true,
): FolderLister {
  let known: { mtimeMs: number; names: readonly string[]; at: number } | null = null;

  return {
    async list(now) {
      let info;
      try {
        info = await io.lstat(dir);
      } catch (error) {
        known = null;
        return isMissing(error) ? { state: "missing" } : { state: "unlistable" };
      }
      if (info.kind !== "directory" || !accept(info)) {
        known = null;
        return { state: "unlistable" };
      }
      // A clock set back counts as time enough.
      const since = known === null ? null : now - known.at;
      const due = since === null || since < 0 || since >= sweepMs;
      if (known !== null && !due && known.mtimeMs === info.mtimeMs) {
        return { state: "listed", names: known.names };
      }
      try {
        const names = (await io.readdir(dir)).sort();
        known = { mtimeMs: info.mtimeMs, names, at: now };
        return { state: "listed", names };
      } catch (error) {
        known = null;
        return isMissing(error) ? { state: "missing" } : { state: "unlistable" };
      }
    },
  };
}
