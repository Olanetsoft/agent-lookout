import path from "node:path";

import { sameFolder } from "../../files/paths.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Finding Gemini CLI's project folders, and the folder each one is for.
 *
 * Gemini CLI keeps each project's sessions in `<gemini folder>/tmp/<project>/`,
 * where the project is a short name made from the last part of the folder it
 * was started in, such as `demo-project`, with `-1`, `-2` and so on for a
 * clash. Before version 0.29 it was a hash of the folder's path. Next to
 * `chats/` it writes `.project_root`, which holds that folder's path as plain
 * text, written once (packages/core/src/config/projectRegistry.ts at v0.64.0).
 * On Windows it writes that path in lower case, so the folder's own case is
 * asked of the system, and taken when it differs from the text in case alone.
 *
 * `tmp/` also holds folders that are not projects, `bin` and
 * `background-processes`, which are passed over unless they hold a
 * `.project_root`, and files, which are not folders. Gemini CLI gives a
 * project either name when its folder is named so, and then keeps that
 * project's files in the same folder as its own. Nothing else in a project's
 * folder is opened here, and `projects.json`, which says the same as every
 * `.project_root` at once, is never opened.
 */

/**
 * Folders in `tmp/` that Gemini CLI uses for its own programs. They are a
 * project's too only when a project of the same name has written its
 * `.project_root` in them.
 */
export const NOT_PROJECTS: ReadonlySet<string> = new Set(["bin", "background-processes"]);

/** The file in a project's folder that names the folder the project is for. */
export const PROJECT_ROOT_FILE = ".project_root";

/** The largest `.project_root` read. A path is much shorter. */
export const PROJECT_ROOT_LIMIT_BYTES = 4 * 1024;

/** How often, at most, `tmp/` is listed again when its own modified time has not moved. */
export const PROJECTS_REFRESH_MS = 30_000;

/** Characters no folder's path holds: control characters, a line's end among them. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface Project {
  /** The project folder's name in `tmp/`. */
  slug: string;
  dir: string;
  /** The folder the project is for, from `.project_root`. Null when that cannot be read. */
  cwd: string | null;
}

/** The folder a `.project_root` names, or null when its text is not an absolute path on one line. */
export function projectRootOf(text: string): string | null {
  const root = text.trim();
  if (root === "" || CONTROL.test(root)) return null;
  return path.posix.isAbsolute(root) || path.win32.isAbsolute(root) ? root : null;
}

interface Marker {
  ino: number;
  size: number;
  mtimeMs: number;
  cwd: string | null;
}

export interface ProjectLister {
  /**
   * The project folders in `tmp/`. They are listed again when `tmp/`'s modified
   * time moves, as it does when Gemini CLI adds a folder, and at least every
   * `PROJECTS_REFRESH_MS`. Each `.project_root` is looked at then, and on every
   * call for a project whose folder could not yet be read. Rejects when `tmp/`
   * cannot be listed.
   */
  list(tmpInfo: FileInfo, now: number): Promise<Project[]>;
}

export interface ProjectListerOptions {
  tmpDir: string;
  io: ReadOnlyIo;
  refreshMs?: number;
  /** The system the folders are on. Defaults to this one. */
  platform?: NodeJS.Platform;
}

export function createProjectLister(options: ProjectListerOptions): ProjectLister {
  const { tmpDir, io } = options;
  const refreshMs = options.refreshMs ?? PROJECTS_REFRESH_MS;
  const platform = options.platform ?? process.platform;

  /**
   * On Windows, the folder in the case its disk gives it, so its sessions sit
   * with other agents' sessions in it, under one repository and one name. A
   * path that differs in more than case, through a link, is not taken, and the
   * text stands as written when the system cannot say.
   */
  async function onDisk(cwd: string): Promise<string> {
    if (platform !== "win32" || io.realpath === undefined) return cwd;
    try {
      const real = await io.realpath(cwd);
      return sameFolder(real, cwd, "win32") ? real : cwd;
    } catch {
      return cwd;
    }
  }

  let listedAt: number | null = null;
  let listedMtimeMs: number | null = null;
  let projects: Project[] = [];
  /** What each project's `.project_root` said when it was last read, by the project's folder. */
  const markers = new Map<string, Marker>();

  /** The folder a project is for, read again only when its `.project_root` changed. */
  async function cwdOf(dir: string): Promise<string | null> {
    const file = path.join(dir, PROJECT_ROOT_FILE);
    let info: FileInfo;
    try {
      info = await io.lstat(file);
    } catch {
      markers.delete(dir);
      return null;
    }
    // A link, a folder or anything that is not an ordinary small file is not read.
    if (info.kind !== "file" || info.size > PROJECT_ROOT_LIMIT_BYTES) {
      markers.delete(dir);
      return null;
    }
    const known = markers.get(dir);
    if (
      known &&
      known.ino === info.ino &&
      known.size === info.size &&
      known.mtimeMs === info.mtimeMs
    ) {
      return known.cwd;
    }
    let cwd: string | null = null;
    try {
      const handle = await io.openRegular(file);
      try {
        // The open file is looked at again, in case it grew since the `lstat`.
        if (handle.info.size <= PROJECT_ROOT_LIMIT_BYTES) {
          const data = await handle.read(0, PROJECT_ROOT_LIMIT_BYTES);
          cwd = projectRootOf(Buffer.from(data).toString("utf8"));
        }
      } finally {
        await handle.close();
      }
    } catch {
      markers.delete(dir);
      return null;
    }
    if (cwd !== null) cwd = await onDisk(cwd);
    markers.set(dir, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, cwd });
    return cwd;
  }

  async function listAgain(): Promise<Project[]> {
    const names = (await io.readdir(tmpDir)).sort();
    const found: Project[] = [];
    for (const name of names) {
      const dir = path.join(tmpDir, name);
      let info: FileInfo;
      try {
        info = await io.lstat(dir);
      } catch {
        continue;
      }
      // A file, or a link to a folder elsewhere, is not a project's folder.
      if (info.kind !== "directory") continue;
      const cwd = await cwdOf(dir);
      // Gemini CLI's own folder, unless a project of the same name has claimed it.
      if (NOT_PROJECTS.has(name) && cwd === null) continue;
      found.push({ slug: name, dir, cwd });
    }
    const dirs = new Set(found.map((project) => project.dir));
    for (const dir of markers.keys()) if (!dirs.has(dir)) markers.delete(dir);
    return found;
  }

  return {
    async list(tmpInfo, now) {
      const since = listedAt === null ? null : now - listedAt;
      // A clock set back counts as time enough.
      const due =
        since === null || since < 0 || since >= refreshMs || tmpInfo.mtimeMs !== listedMtimeMs;
      if (due) {
        projects = await listAgain();
        listedAt = now;
        listedMtimeMs = tmpInfo.mtimeMs;
      } else {
        for (const project of projects) {
          if (project.cwd === null) project.cwd = await cwdOf(project.dir);
        }
      }
      return projects.map((project) => ({ ...project }));
    },
  };
}
