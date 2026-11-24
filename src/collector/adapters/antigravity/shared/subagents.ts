import path from "node:path";

import { WRITE_TIME_STEP_MS } from "../../../../core/time.ts";
import { isMissing, type ReadOnlyIo } from "../../../files/readOnlyIo.ts";

/**
 * Which conversations another conversation started, by names alone.
 *
 * agy keeps one record for each subagent and swarm worker a conversation
 * starts, `brain/<conversation id>/.system_generated/subagents/<child id>.json`,
 * named for the child's own conversation. So a conversation was started by
 * another when an ordinary file of its name is in that one's folder of records.
 * docs/adapters/antigravity.md says where that comes from. A record is looked
 * up and never opened.
 *
 * A folder is looked up with one `lstat` and listed again only when it is
 * another folder or its modified time moved, or while that time is less than 2
 * seconds older than the last listing, as a disk can keep it rounded down.
 * Anything but a real folder, a link to one among them, holds no record. Only
 * names that are an id and `.json` are kept, and a bounded number of them: a
 * folder cut short is listed again each time. One that cannot be looked up or
 * listed, for another reason than that it is not there, holds what it last did.
 */

/** The folder of records, inside a conversation's folder under `brain/`. */
export const RECORDS_IN_FOLDER = [".system_generated", "subagents"] as const;

/** The most records kept of one folder, and of all the folders together. */
export const RECORDS_PER_FOLDER = 2_000;
export const RECORDS_KEPT = 20_000;

const RECORD_NAME =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.json$/;

/** The conversation id a record is named for, in lower case, or null for any other name. */
export function conversationIdOfRecord(name: string): string | null {
  return RECORD_NAME.exec(name)?.[1]?.toLowerCase() ?? null;
}

/** One conversation's folder of records, as last listed. */
interface RecordFolder {
  ino: number;
  mtimeMs: number;
  /** When it was listed. Never, when it was cut short. */
  listedAt: number;
  /** The conversations its records are named for. */
  children: string[];
}

/** One record: its name, and whether it was an ordinary file when last looked up. */
interface KeptRecord {
  name: string;
  file: boolean;
}

export interface SubagentRecords {
  /** Looks up one conversation's folder of records, and lists it when it is due. Never rejects. */
  look(parent: string, now: number): Promise<void>;
  /** The conversations whose folder, as last listed, has a record named for one. */
  namedIn(id: string): Iterable<string>;
  /** The conversations that started one: those, where an `lstat` says its record is an ordinary file. Never rejects. */
  parentsOf(id: string): Promise<string[]>;
  /** Forgets the folders of every conversation but these. */
  keepOnly(parents: ReadonlySet<string>): void;
  /** How many records it keeps, and of how many children, for the tests that check they are bounded and let go. */
  readonly kept: { records: number; children: number };
}

export function createSubagentRecords(options: {
  brainDir: string;
  io: ReadOnlyIo;
}): SubagentRecords {
  const { brainDir, io } = options;
  const folders = new Map<string, RecordFolder>();
  /** For each child, its record in each conversation's folder that has one. */
  const records = new Map<string, Map<string, KeptRecord>>();
  let kept = 0;

  const folderOf = (parent: string) => path.join(brainDir, parent, ...RECORDS_IN_FOLDER);

  function forget(parent: string): void {
    for (const child of folders.get(parent)?.children ?? []) {
      const named = records.get(child);
      if (named?.delete(parent)) kept -= 1;
      if (named?.size === 0) records.delete(child);
    }
    folders.delete(parent);
  }

  async function look(parent: string, now: number): Promise<void> {
    const dir = folderOf(parent);
    const info = await io.lstat(dir);
    if (info.kind !== "directory") return forget(parent);
    const last = folders.get(parent);
    if (
      last?.ino === info.ino &&
      last.mtimeMs === info.mtimeMs &&
      last.listedAt >= info.mtimeMs + WRITE_TIME_STEP_MS
    ) {
      return;
    }
    const names = await io.readdir(dir);
    forget(parent);
    const children: string[] = [];
    let listedAt = now;
    for (const name of names) {
      if (children.length >= RECORDS_PER_FOLDER || kept >= RECORDS_KEPT) {
        listedAt = -Infinity;
        break;
      }
      const child = conversationIdOfRecord(name);
      // A record named for the conversation it is kept in says nothing.
      if (child === null || child === parent) continue;
      const named = records.get(child) ?? new Map<string, KeptRecord>();
      if (named.has(parent)) continue;
      records.set(child, named.set(parent, { name, file: false }));
      children.push(child);
      kept += 1;
    }
    folders.set(parent, { ino: info.ino, mtimeMs: info.mtimeMs, listedAt, children });
  }

  return {
    async look(parent, now) {
      try {
        await look(parent, now);
      } catch (error) {
        if (isMissing(error)) forget(parent);
      }
    },
    namedIn: (id) => records.get(id)?.keys() ?? [],
    async parentsOf(id) {
      const parents: string[] = [];
      for (const [parent, record] of records.get(id) ?? []) {
        try {
          record.file = (await io.lstat(path.join(folderOf(parent), record.name))).kind === "file";
        } catch (error) {
          if (isMissing(error)) record.file = false;
        }
        if (record.file) parents.push(parent);
      }
      return parents;
    },
    keepOnly(parents) {
      for (const parent of folders.keys()) if (!parents.has(parent)) forget(parent);
    },
    get kept() {
      return { records: kept, children: records.size };
    },
  };
}
