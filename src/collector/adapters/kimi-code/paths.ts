import path from "node:path";

import type { ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Where Kimi Code keeps a session, under its folder (`~/.kimi-code`):
 * `sessions/<workDirKey>/<sessionId>/`, with `state.json` and
 * `agents/main/wire.jsonl` in it. Built from Kimi Code's source at 2.4.1 and not
 * yet checked on a computer running it.
 */

/** The folder of sessions, in Kimi Code's folder. */
export const SESSIONS_DIR = "sessions";

/** Where a session's event file is, in its folder. */
export const WIRE_FOLDERS = ["agents", "main"] as const;

export const WIRE_FILE = "wire.jsonl";

export const STATE_FILE = "state.json";

/**
 * A name that can be one folder: never `.` or `..`, and nothing that could leave
 * the folder it is in. Nothing else from a file is ever made part of a path.
 */
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function isFolderName(value: unknown): value is string {
  return typeof value === "string" && FOLDER_NAME.test(value);
}

/** A session's place: the bucket of its folder and its own id, both checked. */
export interface SessionPlace {
  id: string;
  bucket: string;
}

/** The folders from Kimi Code's own down to a session's. */
const sessionFolders = ({ id, bucket }: SessionPlace) => [SESSIONS_DIR, bucket, id];

export function stateFilePath(home: string, place: SessionPlace): string {
  return path.join(home, ...sessionFolders(place), STATE_FILE);
}

export function wireFilePath(home: string, place: SessionPlace): string {
  return path.join(home, ...sessionFolders(place), ...WIRE_FOLDERS, WIRE_FILE);
}

/**
 * Whether every folder down from `home` is a real folder, and none a link.
 * Opening a file does not look at the names before its own. Rejects when one of
 * them cannot be looked at.
 */
export async function isReachedByRealFolders(
  home: string,
  folders: readonly string[],
  io: Pick<ReadOnlyIo, "lstat">,
): Promise<boolean> {
  let at = home;
  for (const folder of folders) {
    at = path.join(at, folder);
    if ((await io.lstat(at)).kind !== "directory") return false;
  }
  return true;
}

/** Whether a session's `state.json` is reached with no link on the way. */
export function stateFolderIsReal(
  home: string,
  place: SessionPlace,
  io: Pick<ReadOnlyIo, "lstat">,
): Promise<boolean> {
  return isReachedByRealFolders(home, sessionFolders(place), io);
}

/** Whether a session's `wire.jsonl` is reached with no link on the way. */
export function wireFolderIsReal(
  home: string,
  place: SessionPlace,
  io: Pick<ReadOnlyIo, "lstat">,
): Promise<boolean> {
  return isReachedByRealFolders(home, [...sessionFolders(place), ...WIRE_FOLDERS], io);
}
