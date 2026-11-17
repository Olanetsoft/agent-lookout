import path from "node:path";

import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import type { LogRef } from "./logFile.ts";
import { isSessionId } from "./logLines.ts";
import { LOG_FILE } from "./paths.ts";

/**
 * Finding fx's session logs, without opening any of them.
 *
 * fx keeps each session in its own folder, `<v2>/<id>/`, beside its list of
 * sessions, `index.jsonl`, and the folders it makes and removes them in,
 * `.tmp` and `.trash`. A session's folder is renamed in whole once its first
 * line is on disk, and out in whole when it is deleted, so `v2`'s modified
 * time moves when a session comes or goes, and not when a log is added to
 * (`publish` and `delete` in `session.zig`). So `v2` is listed again only when
 * its modified time moves, and once a minute. Only a name fx would give a
 * session is taken: `index.jsonl`, `index.lock` and a name that starts with a
 * `.` are never looked at (`validId` in `schema.zig`).
 *
 * Pi's finder takes every name that ends in `.jsonl`, which here would be
 * the index, so this one is fx's own.
 *
 * Each session's folder and its log are looked up with `lstat` on each poll,
 * so a link at either is never followed, and a log not written to for a day
 * is passed over until the next sweep, once a minute. So is a subagent's
 * session once it is known to be one: at each sweep it is looked up again,
 * and its log is read again only when it is another file.
 */

/** How often `v2` is listed and every log looked up. */
export const SWEEP_MS = 60_000;

/** The most sessions looked at, newest first, a subagent's left out. The others wait for the next sweep. */
export const MAX_SESSIONS = 200;

export interface FoundLogs {
  /** Every name in `v2` that can be a session's, as last listed. */
  ids: ReadonlySet<string>;
  /** The logs to read, newest first. */
  refs: LogRef[];
}

export interface LogFinder {
  /**
   * The logs written to in the last day, newest first, at most `MAX_SESSIONS`
   * of them besides the subagents' ones a sweep looks up again, given what an
   * `lstat` of `v2` said this poll. Rejects, with the error's `code`, when
   * `v2` cannot be listed.
   */
  recent(now: number, v2: FileInfo, isChild: (id: string) => boolean): Promise<FoundLogs>;
  /** Forgets everything, as for a `v2` that went. */
  forget(): void;
}

export function createLogFinder(options: {
  sessionsDir: string;
  io: ReadOnlyIo;
  sweepMs?: number;
}): LogFinder {
  const { sessionsDir, io } = options;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  /** What `v2` held when it was last listed, with its modified time then. */
  let listed: { mtimeMs: number; ids: Set<string> } | null = null;
  /** The sessions last found not to be worth a look, passed over until the next sweep. */
  let passedOver = new Set<string>();
  let sweptAt: number | null = null;

  async function infoOf(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch {
      return null;
    }
  }

  return {
    async recent(now, v2, isChild) {
      // A clock set back counts as time enough.
      const since = sweptAt === null ? null : now - sweptAt;
      const sweep = since === null || since < 0 || since >= sweepMs;
      if (sweep || listed?.mtimeMs !== v2.mtimeMs) {
        const names = await io.readdir(sessionsDir);
        listed = { mtimeMs: v2.mtimeMs, ids: new Set(names.filter(isSessionId).sort()) };
      }
      if (sweep) {
        sweptAt = now;
        passedOver = new Set();
      }

      const refs: LogRef[] = [];
      const children: LogRef[] = [];
      for (const id of listed.ids) {
        if (passedOver.has(id)) continue;
        const child = isChild(id);
        if (child && !sweep) continue;
        const dir = path.join(sessionsDir, id);
        // A link at a session's folder is not followed: it would lead out of `v2`.
        if ((await infoOf(dir))?.kind !== "directory") continue;
        const file = path.join(dir, LOG_FILE);
        const info = await infoOf(file);
        // A link, a pipe or a device is not a log, whatever it is called.
        if (info?.kind !== "file") continue;
        if (!isWithinRetention(Math.floor(info.mtimeMs), now)) passedOver.add(id);
        else (child ? children : refs).push({ id, path: file, info });
      }
      refs.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.id.localeCompare(b.id));
      for (const ref of refs.slice(MAX_SESSIONS)) passedOver.add(ref.id);
      return { ids: listed.ids, refs: [...refs.slice(0, MAX_SESSIONS), ...children] };
    },

    forget() {
      listed = null;
      passedOver = new Set();
      sweptAt = null;
    },
  };
}
