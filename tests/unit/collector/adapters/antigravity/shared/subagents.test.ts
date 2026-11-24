import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  conversationIdOfRecord,
  createSubagentRecords,
  RECORDS_KEPT,
  RECORDS_PER_FOLDER,
  type SubagentRecords,
} from "@collector/adapters/antigravity/shared/subagents";
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
import { WRITE_TIME_STEP_MS } from "@core/time";
import {
  AGY_HOME,
  conversationId,
  DAY,
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  SECOND,
  subagentsPath,
} from "@tests/fixtures/antigravity";
import { handClock, memoryFiles } from "@tests/support/adapters/antigravityAdapter";

const PARENT = conversationId("a1");
const OTHER = conversationId("b2");
const CHILD = conversationId("c3");
const SECOND_CHILD = conversationId("d4");

const FOLDER = subagentsPath(AGY_HOME, PARENT);
const RECORD = subagentsPath(AGY_HOME, PARENT, `${CHILD}.json`);

const isChild = async (records: SubagentRecords, id: string) =>
  (await records.parentsOf(id)).length > 0;

function setUp() {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const records = createSubagentRecords({
    brainDir: path.join(AGY_HOME, "brain"),
    io: files.io,
  });
  const look = (...parents: string[]) =>
    Promise.all(parents.map((parent) => records.look(parent, clock.now())));
  /** Writes a record, which moves its folder's time on as it does on a disk. */
  const record = (parent: string, name: string, at = clock.now()) => {
    files.write(subagentsPath(AGY_HOME, parent, name), `{"role":"${PRIVATE_WORDS}"}`, {
      mtimeMs: at,
    });
    files.touch(subagentsPath(AGY_HOME, parent), at);
  };
  return { clock, files, records, look, record };
}

test("a record's name is a conversation id and .json, and nothing else is", () => {
  expect(conversationIdOfRecord(`${CHILD}.json`)).toBe(CHILD);
  expect(conversationIdOfRecord(`${CHILD.toUpperCase()}.json`)).toBe(CHILD);
  for (const name of [
    CHILD,
    `${CHILD}.JSON`,
    `${CHILD}.json.tmp`,
    `.${CHILD}.json`,
    `${CHILD}.jsonl`,
    `${CHILD.slice(1)}.json`,
    `${CHILD}0.json`,
    `${CHILD}.json\n`,
    "members.json",
    "",
  ]) {
    expect(conversationIdOfRecord(name), name).toBeNull();
  }
});

describe("telling a child by its record's name", () => {
  test("a conversation whose record is in another's folder is a child, and the other is not", async () => {
    const { records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`);
    await look(PARENT, CHILD);
    expect(await records.parentsOf(CHILD)).toEqual([PARENT]);
    expect(await records.parentsOf(PARENT)).toEqual([]);
    expect(await records.parentsOf(OTHER)).toEqual([]);
  });

  test("each conversation with a record of one started it", async () => {
    const { records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`);
    record(OTHER, `${CHILD}.json`);
    await look(PARENT, OTHER);
    expect(await records.parentsOf(CHILD)).toEqual([PARENT, OTHER]);
    expect([...records.namedIn(CHILD)]).toEqual([PARENT, OTHER]);
    expect([...records.namedIn(PARENT)]).toEqual([]);
  });

  test("a name in two cases is one record", async () => {
    const { records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`);
    record(PARENT, `${CHILD.toUpperCase()}.json`);
    await look(PARENT);
    expect(await records.parentsOf(CHILD)).toEqual([PARENT]);
    expect(records.kept).toEqual({ records: 1, children: 1 });
    records.keepOnly(new Set());
    expect(records.kept).toEqual({ records: 0, children: 0 });
  });

  test("so is a child's own child", async () => {
    const { records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`);
    record(CHILD, `${SECOND_CHILD}.json`);
    await look(PARENT, CHILD, SECOND_CHILD);
    expect(await isChild(records, CHILD)).toBe(true);
    expect(await isChild(records, SECOND_CHILD)).toBe(true);
    expect(await isChild(records, PARENT)).toBe(false);
  });

  test("a record's name is taken in any case", async () => {
    const { records, look, record } = setUp();
    record(PARENT, `${CHILD.toUpperCase()}.json`);
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(true);
  });

  test("a record named for the conversation it is kept in says nothing", async () => {
    const { records, look, record } = setUp();
    record(PARENT, `${PARENT}.json`);
    await look(PARENT);
    expect(await isChild(records, PARENT)).toBe(false);
    expect(records.kept).toEqual({ records: 0, children: 0 });

    // In another's folder it does.
    record(OTHER, `${PARENT}.json`);
    await look(PARENT, OTHER);
    expect(await isChild(records, PARENT)).toBe(true);
  });

  test("a name that is not an id and .json is not a record, and a coordinator's swarm folder is not looked in", async () => {
    const { files, records, look, record } = setUp();
    for (const name of [CHILD, `${CHILD}.json.tmp`, "index.json"]) record(PARENT, name);
    files.write(`${AGY_HOME}/brain/${PARENT}/.system_generated/swarm/members.json`, "{}");
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(false);
    expect(records.kept).toEqual({ records: 0, children: 0 });
    expect(files.count(undefined, (target) => target.includes("swarm"))).toBe(0);
  });

  test("a link, or a folder, in a record's place is not one", async () => {
    const { files, records, look } = setUp();
    files.special(RECORD);
    files.mkdir(subagentsPath(AGY_HOME, PARENT, `${SECOND_CHILD}.json`));
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(false);
    expect(await isChild(records, SECOND_CHILD)).toBe(false);

    // Nor one that could not be looked up yet, but a record of it elsewhere still tells.
    const other = subagentsPath(AGY_HOME, OTHER, `${CHILD}.json`);
    files.write(other, "{}");
    files.fail(RECORD);
    files.fail(other);
    await look(OTHER);
    expect(await records.parentsOf(CHILD)).toEqual([]);
    files.heal(other);
    expect(await records.parentsOf(CHILD)).toEqual([OTHER]);

    // One that cannot be looked up this time is what it last was, until it is gone.
    files.fail(other);
    expect(await records.parentsOf(CHILD)).toEqual([OTHER]);
    for (const gone of ["ENOENT", "ENOTDIR"]) {
      files.heal(other);
      expect(await isChild(records, CHILD)).toBe(true);
      files.fail(other, gone);
      expect(await isChild(records, CHILD), gone).toBe(false);
      files.fail(other);
      expect(await isChild(records, CHILD), gone).toBe(false);
    }
  });

  test("a link or a file in the folder's place holds none, and is not listed", async () => {
    for (const place of ["special", "write"] as const) {
      const { files, records, look } = setUp();
      if (place === "special") files.special(FOLDER);
      else files.write(FOLDER, "{}");
      await look(PARENT);
      expect(records.kept).toEqual({ records: 0, children: 0 });
      expect(files.count("readdir"), place).toBe(0);
    }
  });

  test("a link put in the place of a folder that was listed holds none, whatever it leads to", async () => {
    const { files, records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`);
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(true);
    // The record is still found at the same path, as it is through a link.
    files.special(FOLDER);
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(false);
  });

  test("a folder that cannot be looked up this time holds what it last did", async () => {
    const { clock, files, records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`, NOW - MINUTE);
    files.fail(FOLDER, "EIO");
    await look(PARENT);
    expect(records.kept).toEqual({ records: 0, children: 0 });
    files.heal(FOLDER);
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(true);

    files.fail(FOLDER, "EIO");
    clock.advance(2 * SECOND);
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(true);
    files.heal(FOLDER);
    clock.advance(2 * SECOND);
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(true);
  });

  test("one that is not there holds none, and is listed when it is back, as it was", async () => {
    for (const gone of ["ENOENT", "ENOTDIR"]) {
      const { files, records, look, record } = setUp();
      // Long enough ago that it is not listed again while it does not change.
      record(PARENT, `${CHILD}.json`, NOW - MINUTE);
      await look(PARENT);
      files.fail(FOLDER, gone);
      await look(PARENT);
      expect(records.kept, gone).toEqual({ records: 0, children: 0 });
      expect(await isChild(records, CHILD)).toBe(false);
      files.heal(FOLDER);
      await look(PARENT);
      expect(await isChild(records, CHILD), gone).toBe(true);
    }
  });

  test("one that can be looked up and not listed holds what it last did, and is listed once it can be", async () => {
    const { clock, files, record } = setUp();
    let refused: string | null = "EMFILE";
    const io: ReadOnlyIo = {
      ...files.io,
      readdir: (dir) =>
        refused === null
          ? files.io.readdir(dir)
          : Promise.reject(Object.assign(new Error("no"), { code: refused })),
    };
    const records = createSubagentRecords({ brainDir: path.join(AGY_HOME, "brain"), io });
    record(PARENT, `${CHILD}.json`, NOW - MINUTE);
    await records.look(PARENT, clock.now());
    expect(await isChild(records, CHILD)).toBe(false);
    refused = null;
    await records.look(PARENT, clock.now());
    expect(await isChild(records, CHILD)).toBe(true);

    refused = "EMFILE";
    clock.advance(MINUTE);
    record(PARENT, `${SECOND_CHILD}.json`, NOW);
    await records.look(PARENT, clock.now());
    expect(await isChild(records, CHILD)).toBe(true);
    expect(await isChild(records, SECOND_CHILD)).toBe(false);
    refused = null;
    await records.look(PARENT, clock.now());
    expect(await isChild(records, SECOND_CHILD)).toBe(true);
  });

  test("a record is looked up and never opened, and nothing of it is read", async () => {
    const { files, records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`);
    await look(PARENT);
    await isChild(records, CHILD);
    expect(files.calls).toEqual([
      { method: "lstat", path: FOLDER },
      { method: "readdir", path: FOLDER },
      { method: "lstat", path: RECORD },
    ]);
    expect(files.reads).toEqual([]);
  });
});

describe("how often a folder is listed", () => {
  test("again only when its time moves", async () => {
    const { clock, files, records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`, NOW - MINUTE);
    await look(PARENT);
    files.forget();

    for (let poll = 0; poll < 3; poll += 1) {
      clock.advance(2 * SECOND);
      await look(PARENT);
    }
    expect(files.calls).toEqual(
      Array.from({ length: 3 }, () => ({ method: "lstat", path: FOLDER })),
    );
    expect(await isChild(records, CHILD)).toBe(true);

    clock.advance(DAY);
    record(PARENT, `${SECOND_CHILD}.json`);
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(true);
    expect(await isChild(records, SECOND_CHILD)).toBe(true);
  });

  test("again while its time is not older than a listing by the 2 seconds a disk can round it down, so a record added in that step is seen", async () => {
    const { clock, files, records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`);
    await look(PARENT);
    // Another record, in the same step of the disk's time.
    clock.advance(SECOND);
    record(PARENT, `${SECOND_CHILD}.json`, NOW);
    clock.advance(SECOND / 2);
    await look(PARENT);
    expect(await isChild(records, SECOND_CHILD)).toBe(true);

    // Once it has been listed after that, it is settled.
    clock.set(NOW + WRITE_TIME_STEP_MS);
    await look(PARENT);
    files.forget();
    clock.advance(2 * SECOND);
    await look(PARENT);
    expect(files.count("readdir")).toBe(0);
  });

  test("again when its time goes back, as when it is restored from a copy", async () => {
    const { clock, records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`, NOW - MINUTE);
    await look(PARENT);
    record(PARENT, `${SECOND_CHILD}.json`, NOW - DAY);
    clock.advance(2 * SECOND);
    await look(PARENT);
    expect(await isChild(records, SECOND_CHILD)).toBe(true);
  });

  test("and a record taken out of it is let go", async () => {
    const { clock, files, records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`);
    record(PARENT, `${SECOND_CHILD}.json`);
    await look(PARENT);
    expect(records.kept).toEqual({ records: 2, children: 2 });
    files.remove(RECORD);
    clock.advance(MINUTE);
    files.touch(FOLDER, clock.now());
    await look(PARENT);
    expect(records.kept).toEqual({ records: 1, children: 1 });
    expect(await isChild(records, CHILD)).toBe(false);
    expect(await isChild(records, SECOND_CHILD)).toBe(true);
    records.keepOnly(new Set());
    expect(records.kept).toEqual({ records: 0, children: 0 });
  });

  test("again when another folder is put in its place with the same time", async () => {
    const { files, records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`, NOW - MINUTE);
    await look(PARENT);
    let moved = false;
    const io: ReadOnlyIo = {
      ...files.io,
      lstat: async (target) => {
        const info = await files.io.lstat(target);
        return moved && target.endsWith("subagents") ? { ...info, ino: info.ino + 1_000 } : info;
      },
    };
    const swapped = createSubagentRecords({ brainDir: path.join(AGY_HOME, "brain"), io });
    await swapped.look(PARENT, NOW);
    files.remove(RECORD);
    files.write(subagentsPath(AGY_HOME, PARENT, `${SECOND_CHILD}.json`), "{}");
    moved = true;
    await swapped.look(PARENT, NOW);
    expect(await isChild(swapped, SECOND_CHILD)).toBe(true);
    expect(await isChild(swapped, CHILD)).toBe(false);
    // The one that saw no other folder keeps its listing, and the record is gone.
    await look(PARENT);
    expect(await isChild(records, CHILD)).toBe(false);
  });
});

describe("what is kept", () => {
  /** A disk whose folders each hold this many records, of conversations of their own. */
  function fullDisk(perFolder: number) {
    const names = (parent: string) =>
      Array.from(
        { length: perFolder },
        (_, index) => `${parent.slice(0, 24)}${String(index).padStart(12, "0")}.json`,
      );
    const info = { size: 0, mtimeMs: NOW - MINUTE, ino: 1 };
    const io: ReadOnlyIo = {
      readdir: async (dir) => names(path.basename(path.dirname(path.dirname(dir)))),
      stat: () => Promise.reject(new Error("not asked")),
      lstat: async (target) => ({
        ...info,
        kind: target.endsWith(".json") ? "file" : "directory",
      }),
      openRegular: () => Promise.reject(new Error("not opened")),
    };
    return { io, names };
  }

  const parentOf = (index: number) =>
    `${String(index).padStart(8, "0")}-0000-4000-8000-ffffffffffff`;
  const childOf = (name: string) => name.slice(0, -".json".length);

  test("at most so many records of one folder, and the rest are no children", async () => {
    const { io, names } = fullDisk(RECORDS_PER_FOLDER + 5);
    const records = createSubagentRecords({ brainDir: path.join(AGY_HOME, "brain"), io });
    await records.look(parentOf(1), NOW);
    expect(records.kept.records).toBe(RECORDS_PER_FOLDER);
    const all = names(parentOf(1));
    expect(await isChild(records, childOf(all[RECORDS_PER_FOLDER - 1]))).toBe(true);
    expect(await isChild(records, childOf(all[RECORDS_PER_FOLDER]))).toBe(false);
  });

  test("a folder that was cut short is listed again each time, so its records are kept once there is room", async () => {
    const { io, names } = fullDisk(RECORDS_PER_FOLDER);
    let listed = 0;
    const counting: ReadOnlyIo = {
      ...io,
      readdir: (dir) => {
        listed += 1;
        return io.readdir(dir);
      },
    };
    const records = createSubagentRecords({
      brainDir: path.join(AGY_HOME, "brain"),
      io: counting,
    });
    const count = RECORDS_KEPT / RECORDS_PER_FOLDER + 1;
    const parents = Array.from({ length: count }, (_, index) => parentOf(index + 1));
    for (const parent of parents) await records.look(parent, NOW);
    const last = parents[count - 1];
    listed = 0;
    // Those with room for all they hold are not listed again.
    for (const parent of parents) await records.look(parent, NOW);
    expect(listed).toBe(1);

    records.keepOnly(new Set(parents.slice(1)));
    await records.look(last, NOW);
    expect(await isChild(records, childOf(names(last)[0]))).toBe(true);
    listed = 0;
    await records.look(last, NOW);
    expect(listed).toBe(0);
  });

  test("at most so many of all the folders together, fewer once some are let go", async () => {
    const { io, names } = fullDisk(RECORDS_PER_FOLDER);
    const records = createSubagentRecords({ brainDir: path.join(AGY_HOME, "brain"), io });
    const count = RECORDS_KEPT / RECORDS_PER_FOLDER + 1;
    const parents = Array.from({ length: count }, (_, index) => parentOf(index + 1));
    for (const parent of parents) await records.look(parent, NOW);
    expect(records.kept.records).toBe(RECORDS_KEPT);
    const last = parents[count - 1];
    expect(await isChild(records, childOf(names(last)[0]))).toBe(false);

    records.keepOnly(new Set(parents.slice(1)));
    expect(records.kept.records).toBe(RECORDS_KEPT - RECORDS_PER_FOLDER);
    expect(await isChild(records, childOf(names(parents[0])[0]))).toBe(false);
    expect(await isChild(records, childOf(names(parents[1])[0]))).toBe(true);
  });

  test("nothing of a conversation that has gone, while another that names the same child still does", async () => {
    const { records, look, record } = setUp();
    record(PARENT, `${CHILD}.json`);
    record(OTHER, `${CHILD}.json`);
    await look(PARENT, OTHER);
    expect(records.kept).toEqual({ records: 2, children: 1 });
    records.keepOnly(new Set([OTHER]));
    expect(records.kept).toEqual({ records: 1, children: 1 });
    expect(await isChild(records, CHILD)).toBe(true);
    records.keepOnly(new Set());
    expect(records.kept).toEqual({ records: 0, children: 0 });
    expect(await isChild(records, CHILD)).toBe(false);
  });
});
