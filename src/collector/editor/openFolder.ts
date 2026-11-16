import { lstat, realpath } from "node:fs/promises";

import { EDITOR_FOLDER_CHECK_TIMEOUT_MS } from "../../core/api.ts";
import { editorOfBundle, isPlainPath, type EditorWindow } from "./editorWindows.ts";
import type { RunEditor } from "./program.ts";

// The one thing the collector does to an editor: runs the editor's own command
// with `--new-window` and a session's folder. The editor brings forward the
// window that has exactly that folder open, out of the Dock if it was
// minimised, and opens the folder in a new window when no window has it, so a
// window's folder is never replaced. The two values that vary are the app's
// bundle, which `ps` gave, and the folder the session names. Each is checked,
// by its text and the folder on disk too, before the command is run with
// those two arguments and nothing else. The folder is a whole path, so it is
// never read as an option.

/** VS Code's own command, in its app's bundle, as it is on a Mac for VS Code and VS Code Insiders. */
export const EDITOR_COMMAND = "Contents/Resources/app/bin/code";

/** What the command is told: open in a window of its own unless one has exactly this folder. */
export const NEW_WINDOW = "--new-window";

/**
 * Whether a session's folder may be handed to an editor, by its text: a plain
 * whole path with no part ending in `.app`, in any case, so it is neither an
 * app nor inside one, and neither `/` nor the person's home folder, which
 * would be opened whole. The home folder is each of the paths given, in any
 * case: see `homeFolders`.
 */
export function isFolderPath(value: unknown, ...homeDirs: readonly string[]): value is string {
  if (!isPlainPath(value) || value === "/") return false;
  const folder = value.toLowerCase();
  if (homeDirs.some((homeDir) => homeDir.toLowerCase() === folder)) return false;
  return !folder.split("/").some((part) => part.endsWith(".app"));
}

/**
 * The person's home folder as it is named, and as it is with every link on
 * the way followed when that differs, so a folder is refused as the home
 * folder whichever way it is written. Just the name when the links cannot be
 * followed. It never rejects.
 */
export async function homeFolders(
  homeDir: string,
  resolve: (path: string) => Promise<string> = realpath,
): Promise<[string, ...string[]]> {
  try {
    const real = await resolve(homeDir);
    return real === homeDir ? [homeDir] : [homeDir, real];
  } catch {
    return [homeDir];
  }
}

/** The command an editor is asked with: its program and its arguments. */
export interface EditorCommand {
  /** The editor's own command, inside the bundle found for the session. */
  program: string;
  /** `--new-window`, then the folder. */
  args: string[];
}

/**
 * The command that opens a folder in an editor: `code` in the bundle, with
 * `--new-window` and the folder, and nothing else. Null, and nothing is run,
 * for a bundle that is not a plain whole path, or not the editor it says, or
 * a folder `isFolderPath` refuses.
 */
export function editorCommandFor(
  editor: EditorWindow,
  folder: string,
  homeDir: string,
): EditorCommand | null {
  if (!isPlainPath(editor.bundle) || editorOfBundle(editor.bundle) !== editor.app) return null;
  if (!isFolderPath(folder, homeDir)) return null;
  return { program: `${editor.bundle}/${EDITOR_COMMAND}`, args: [NEW_WINDOW, folder] };
}

/**
 * Why a folder was not opened.
 *
 * folder-gone  nothing is at the folder's path, or a file is
 * folder-link  a link is at the folder's path, wherever it leads
 * not-opened   the folder could not be checked in time or at all, its real path leads into an app
 *              or is `/` or the home folder, or its text is not one an editor is handed
 * failed       the editor's command could not be run, failed or did not answer in time
 */
export type OpenFolderFailure = "folder-gone" | "folder-link" | "not-opened" | "failed";

export type OpenFolderOutcome = { ok: true } | { ok: false; reason: OpenFolderFailure };

/** The errors that say a path is not there: nothing at it, a file on the way, or a loop of links. */
const GONE = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/** What is at a session's folder when Jump is pressed. */
type FolderState = "there" | "gone" | "link" | "refused" | "unreadable";

/**
 * "there" when the path is a folder itself, not a link, and its real path,
 * every link on the way followed, still passes `isFolderPath`, with the home
 * folder both as it is named and as its own links lead; "gone" when nothing
 * is there, or a file is; "link" when a link is, wherever it leads; "refused"
 * when the real path does not pass; "unreadable" for any other error, such as
 * macOS refusing a look.
 */
async function folderState(folder: string, homeDir: string): Promise<FolderState> {
  try {
    const found = await lstat(folder);
    if (found.isSymbolicLink()) return "link";
    if (!found.isDirectory()) return "gone";
    const [real, homes] = await Promise.all([realpath(folder), homeFolders(homeDir)]);
    return isFolderPath(real, ...homes) ? "there" : "refused";
  } catch (error) {
    return GONE.has((error as NodeJS.ErrnoException).code ?? "") ? "gone" : "unreadable";
  }
}

/**
 * What a piece of work that never rejects came to, or `late` once it has taken
 * `timeoutMs`. The work is not stopped, only no longer waited for.
 */
export async function settledWithin<T>(work: Promise<T>, timeoutMs: number, late: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lateness = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(late), timeoutMs);
  });
  try {
    return await Promise.race([work, lateness]);
  } finally {
    clearTimeout(timer);
  }
}

export interface OpenFolderOptions {
  /**
   * The person's home folder, which is never handed to an editor, as it is
   * named or with its links followed.
   */
  homeDir: string;
  /** How long the look at the folder gets. Defaults to `EDITOR_FOLDER_CHECK_TIMEOUT_MS`. */
  checkTimeoutMs?: number;
}

/**
 * Opens a session's folder in the editor found running it. `folder-gone`,
 * `folder-link` and `not-opened` are said before anything is run, and `failed`
 * when the command cannot be built, or failed or took too long. The folder's
 * look has a time of its own, so it never holds a press for long.
 */
export async function openFolder(
  editor: EditorWindow,
  folder: string,
  run: RunEditor,
  options: OpenFolderOptions,
): Promise<OpenFolderOutcome> {
  const { homeDir } = options;
  if (!isFolderPath(folder, homeDir)) return { ok: false, reason: "not-opened" };
  const command = editorCommandFor(editor, folder, homeDir);
  if (command === null) return { ok: false, reason: "failed" };

  // A look that takes longer than its time is one that could not be made.
  const state = await settledWithin(
    folderState(folder, homeDir),
    options.checkTimeoutMs ?? EDITOR_FOLDER_CHECK_TIMEOUT_MS,
    "unreadable" as const,
  );
  if (state === "gone") return { ok: false, reason: "folder-gone" };
  if (state === "link") return { ok: false, reason: "folder-link" };
  if (state !== "there") return { ok: false, reason: "not-opened" };

  const result = await run(command.program, command.args);
  return result.ok ? { ok: true } : { ok: false, reason: "failed" };
}
