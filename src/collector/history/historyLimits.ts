// How much history is kept, and which files go when there is too much. Pure,
// so the age and the cap are tested with a clock and a list of files of a
// test's own.

import type { HistoryKept } from "../../core/api.ts";
import { byFileOrder, dayEnd, type HistoryFileName } from "./historyFormat.ts";

/** The most the history's files may hold in all: 20 MB. */
export const HISTORY_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The most one file may hold: 2 MB. A day that outgrows it goes on in the
 * next file, so the cap is kept by letting whole files go, and the oldest
 * going costs a tenth of what is kept at most. A file much larger than this
 * is not one this version wrote, and is not read.
 */
export const HISTORY_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** How long a day's history is kept: 8 days after the day ends. */
export const HISTORY_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** What `/api/history` says with `AGENT_LOOKOUT_HISTORY=off`: kept in memory only, and nothing to clear. */
export function memoryOnlyStatus(): HistoryKept {
  return {
    where: "memory",
    folder: null,
    bytes: null,
    maxBytes: HISTORY_MAX_BYTES,
    maxAgeMs: HISTORY_MAX_AGE_MS,
    canClear: false,
    problem: null,
  };
}

/** A file of the history, as the folder holds it: its name and how large it is. */
export interface KeptFile extends HistoryFileName {
  size: number;
}

export interface PruneLimits {
  now: number;
  maxBytes: number;
  maxAgeMs: number;
}

/**
 * The files to delete, oldest first, before `incoming` more bytes are written
 * to the file named `writingTo`:
 *
 * - every file whose day ended longer ago than the age, so a day is kept for at
 *   least that long and gone within a day after;
 * - then, oldest first, as many more as it takes for what is left and what is
 *   coming to fit under the cap. The file being written to is never one of them.
 *
 * Only files of this version's format are handed in. A file of another format
 * is left alone, and does not count towards the cap.
 */
export function filesToDelete(
  files: readonly KeptFile[],
  writingTo: string | null,
  incoming: number,
  limits: PruneLimits,
): string[] {
  const ordered = [...files].sort(byFileOrder);
  const doomed: string[] = [];
  let total = 0;
  const left: KeptFile[] = [];
  for (const file of ordered) {
    if (file.name !== writingTo && dayEnd(file) + limits.maxAgeMs < limits.now) {
      doomed.push(file.name);
    } else {
      left.push(file);
      total += file.size;
    }
  }
  for (const file of left) {
    if (total + incoming <= limits.maxBytes) break;
    if (file.name === writingTo) continue;
    doomed.push(file.name);
    total -= file.size;
  }
  return doomed;
}
