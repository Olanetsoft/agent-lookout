// Unpacks a downloaded zip and checks that what is in it is this app, at the
// version offered, before it may take the running app's place.
//
// The zip is unpacked with `/usr/bin/ditto -x -k`, which keeps the bundle's
// links, permissions and signature as electron-builder packed them. Then the
// bundle's `Info.plist` is read: its `CFBundleIdentifier` must be this app's,
// and its `CFBundleShortVersionString` the version the release offers. A plist
// in the binary format is first turned into XML by `/usr/bin/plutil`.
//
// ditto unpacks a link as a link, so a zip whose app is a link to another app
// would unpack as that link. What is unpacked must be a real folder, with a
// real `Contents` folder and a real `Info.plist` in it, none of them a link.
//
// Both programs are started by their full path, with no shell, with a time
// limit, and with no argument but paths the updater made itself in its own
// temporary folder.

import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { childEnvironment } from "../../../collector/processes/childEnvironment.ts";

/** The two facts of a bundle the updater checks. */
export interface BundleFacts {
  identifier: string;
  version: string;
}

/** What a program printed, or that it failed. It never rejects. */
export type RunProgram = (
  file: string,
  args: readonly string[],
) => Promise<{ ok: true; stdout: string } | { ok: false }>;

export const DITTO = "/usr/bin/ditto";
export const PLUTIL = "/usr/bin/plutil";

/** Unpacking a hundred megabytes takes seconds. This is the most it may take. */
const PROGRAM_TIMEOUT_MS = 120_000;

/** More than an `Info.plist` holds. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Runs a program by its full path, with no shell, stdin closed and a time limit. */
export const runProgram: RunProgram = (file, args) =>
  new Promise((resolve) => {
    try {
      execFile(
        file,
        [...args],
        {
          env: childEnvironment(process.env),
          timeout: PROGRAM_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
        },
        (error, stdout) => resolve(error ? { ok: false } : { ok: true, stdout: String(stdout) }),
      ).stdin?.end();
    } catch {
      resolve({ ok: false });
    }
  });

/** The text of a `<string>` in a plist, with its five XML escapes undone. */
function unescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The string a key of the top-level dictionary holds, in an XML plist. */
function stringOf(xml: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match?.[1] === undefined ? null : unescape(match[1]).trim();
}

/** The identifier and version in the text of an XML `Info.plist`, or null when either is missing. */
export function readInfoPlist(xml: string): BundleFacts | null {
  if (!xml.includes("<plist")) return null;
  const identifier = stringOf(xml, "CFBundleIdentifier");
  const version = stringOf(xml, "CFBundleShortVersionString");
  if (!identifier || !version) return null;
  return { identifier, version };
}

/** The identifier and version of the bundle at `bundle`, or null when they cannot be read. */
export async function bundleFacts(
  bundle: string,
  run: RunProgram = runProgram,
): Promise<BundleFacts | null> {
  const file = path.join(bundle, "Contents", "Info.plist");
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return null;
  }
  if (bytes.subarray(0, 6).toString("latin1") !== "bplist") {
    return readInfoPlist(bytes.toString("utf8"));
  }
  // The path is absolute, so it is never read as an option.
  const converted = await run(PLUTIL, ["-convert", "xml1", "-o", "-", file]);
  return converted.ok ? readInfoPlist(converted.stdout) : null;
}

/** Whether a bundle is a folder, with a `Contents` folder and an `Info.plist` file, none of them a link. */
async function isRealBundle(bundle: string): Promise<boolean> {
  try {
    const [app, contents, plist] = await Promise.all([
      lstat(bundle),
      lstat(path.join(bundle, "Contents")),
      lstat(path.join(bundle, "Contents", "Info.plist")),
    ]);
    return app.isDirectory() && contents.isDirectory() && plist.isFile();
  } catch {
    return false;
  }
}

/**
 * Unpacks `zip` into the empty folder `into` with ditto, and gives the path of
 * the one app bundle at its top, or null when it could not be unpacked, does
 * not hold exactly one, or holds a link where the bundle, its `Contents` or
 * its `Info.plist` should be.
 */
export async function unpackApp(
  zip: string,
  into: string,
  run: RunProgram = runProgram,
): Promise<string | null> {
  const unpacked = await run(DITTO, ["-x", "-k", zip, into]);
  if (!unpacked.ok) return null;
  let names: string[];
  try {
    names = await readdir(into);
  } catch {
    return null;
  }
  // ditto keeps a file's resource fork with it, so nothing beside the app should be there.
  const [only, ...others] = names;
  if (only === undefined || others.length > 0 || !only.endsWith(".app")) return null;
  const app = path.join(into, only);
  return (await isRealBundle(app)) ? app : null;
}
