import { closeSync, constants, fstatSync, lstatSync, openSync, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

/**
 * Opening a file by its name without following a link at that name, and
 * without waiting on a named pipe, on every system. The Claude Code registry,
 * the files read where other programs keep theirs, and Agent Lookout's own
 * history are all opened this way.
 *
 * On macOS and Linux two flags do it: `O_NOFOLLOW` makes the open fail when the
 * name is a symbolic link, and `O_NONBLOCK` makes it return at once for a named
 * pipe, which would otherwise wait for a writer for ever.
 *
 * Windows has neither flag, and Node there follows a link it opens. So there
 * the name is looked at first without following it, and anything but an
 * ordinary file is refused before it is opened, a link with `ELOOP`, as
 * `O_NOFOLLOW` refuses one. Then the file is opened, and
 * unless the open file is that very file, by its disk and its number on that
 * disk, it is closed unread and unwritten, and the open fails: a link put in
 * place of the file between the look and the open is caught that way. A file
 * that was not there, and is made by the open, is looked at once it is made.
 * Windows keeps no named pipe among files, so nothing there can make an open
 * wait.
 */

/** Whether an open on this system follows a link at the file's own name. */
export const OPEN_FOLLOWS_LINKS = constants.O_NOFOLLOW === undefined;

/** The flags that stop an open following a link or waiting on a pipe, where there are any. */
const NO_FOLLOW = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function notOrdinary(): Error {
  return new Error("Not an ordinary file.");
}

/** What a refused name gives: ELOOP for a link, as `O_NOFOLLOW` gives, and no code for anything else. */
function refusal(named: BigIntStats): Error {
  if (!named.isSymbolicLink()) return notOrdinary();
  return Object.assign(new Error("A symbolic link, which is not followed."), { code: "ELOOP" });
}

/** Whether the name holds an ordinary file, and the one that was opened. */
function sameFile(named: BigIntStats, opened: BigIntStats): boolean {
  return named.isFile() && named.dev === opened.dev && named.ino === opened.ino;
}

/** Whether an error says there is nothing at all by that name. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Whether these flags make the file when it is not there. */
const creates = (flags: number) => (flags & constants.O_CREAT) !== 0;

/**
 * Opens a file with these flags, never through a link at its name. `follows`
 * says whether this system's open would follow one, and is replaced only by a
 * test that checks the way Windows is guarded on another system.
 */
export async function openWithoutFollowing(
  file: string,
  flags: number,
  mode?: number,
  follows: boolean = OPEN_FOLLOWS_LINKS,
): Promise<FileHandle> {
  if (!follows) return open(file, flags | NO_FOLLOW, mode);
  let before: BigIntStats | null = null;
  try {
    before = await lstat(file, { bigint: true });
  } catch (error) {
    if (!(isMissing(error) && creates(flags))) throw error;
  }
  if (before !== null && !before.isFile()) throw refusal(before);
  const handle = await open(file, flags, mode);
  try {
    const opened = await handle.stat({ bigint: true });
    const named = before ?? (await lstat(file, { bigint: true }));
    if (!sameFile(named, opened)) throw notOrdinary();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The same at once, for what must be done before Agent Lookout goes on or stops. */
export function openWithoutFollowingNow(
  file: string,
  flags: number,
  mode?: number,
  follows: boolean = OPEN_FOLLOWS_LINKS,
): number {
  if (!follows) return openSync(file, flags | NO_FOLLOW, mode);
  let before: BigIntStats | null = null;
  try {
    before = lstatSync(file, { bigint: true });
  } catch (error) {
    if (!(isMissing(error) && creates(flags))) throw error;
  }
  if (before !== null && !before.isFile()) throw refusal(before);
  const fd = openSync(file, flags, mode);
  try {
    const named = before ?? lstatSync(file, { bigint: true });
    if (!sameFile(named, fstatSync(fd, { bigint: true }))) throw notOrdinary();
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
