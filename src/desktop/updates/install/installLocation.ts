// Where the running app is, and whether a newer version can be put in its
// place there.
//
// The app replaces its own bundle, so the folder it is in must be one it can
// change. Three places are not:
//
// - App Translocation. An app opened where it was downloaded, still marked as
//   downloaded, is run by macOS from a read-only copy at a random path with
//   `/AppTranslocation/` in it.
// - A disk image. The app opened from the image it came in runs from
//   `/Volumes/`, which is read-only.
// - A folder this user cannot write, or a bundle this user cannot move.
//
// In each, the person is told to move the app to Applications and open it
// from there, or to download the new version from its release page.
//
// It imports only Node's path module, with the rules of macOS paths whatever
// system runs it, and is given the check for a folder it can write, so it is
// tested in plain Node, on any system.

import path from "node:path/posix";

import type { InstallRefusal } from "../../../core/appUpdate.ts";

/**
 * The app's bundle, from the path of its executable, which macOS puts at
 * `<bundle>.app/Contents/MacOS/<name>`. Null when the executable is not in a
 * bundle laid out that way.
 */
export function bundleOf(executable: string): string | null {
  if (!path.isAbsolute(executable)) return null;
  const macos = path.dirname(executable);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== "MacOS" || path.basename(contents) !== "Contents") return null;
  if (!bundle.endsWith(".app") || bundle === path.sep) return null;
  return bundle;
}

/** Says whether this user may change a file or folder: Node's `access` with `W_OK`. */
export type CanWrite = (target: string) => boolean;

/**
 * Why a newer version cannot be put where the app runs, or null when it can:
 * the bundle can be moved, and the folder it is in can be written.
 */
export function installRefusal(bundle: string | null, canWrite: CanWrite): InstallRefusal | null {
  if (bundle === null) return "read-only";
  const parts = bundle.split(path.sep);
  if (parts.includes("AppTranslocation")) return "translocated";
  if (parts[1] === "Volumes") return "disk-image";
  if (!canWrite(path.dirname(bundle)) || !canWrite(bundle)) return "read-only";
  return null;
}
